/**
 * @license
 * Copyright 2024 The Model Explorer Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * ==============================================================================
 */

import {CommonModule} from '@angular/common';
import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  DestroyRef,
  effect,
  inject,
  Input,
  OnChanges,
  SimpleChanges,
  ViewChild,
} from '@angular/core';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {FormControl, FormsModule, ReactiveFormsModule} from '@angular/forms';
import {MatIconModule} from '@angular/material/icon';
import {MatProgressSpinnerModule} from '@angular/material/progress-spinner';
import {MatTooltipModule} from '@angular/material/tooltip';
import {debounceTime} from 'rxjs/operators';
import {AppService} from './app_service';
import {COLOR_NAME_TO_HEX, NODE_DATA_PROVIDER_SHOW_ON_NODE_TYPE_PREFIX} from './common/consts';
import {GroupNode, ModelGraph, OpNode} from './common/model_graph';
import {
  AggregatedStat,
  GradientItem,
  NodeDataProviderRunData,
  NodeDataProviderValueInfo,
  ThresholdItem,
} from './common/types';
import {
  genSortedValueInfos,
  getRunName,
  isGroupNode,
  isOpNode,
} from './common/utils';
import {InfoPanelService, SortingDirection} from './info_panel_service';
import {NodeDataProviderExtensionService} from './node_data_provider_extension_service';
import {Paginator} from './paginator';
import {
  ColorVariable,
  VisualizerThemeService,
} from './visualizer_theme_service';

interface Row {
  // Node id.
  id: string;
  // Node label.
  label: string;
  index: number;
  cols: Col[];
  isInput?: boolean;
  isOutput?: boolean;
  sourceSsa?: string;
}

interface ChildrenStatRow {
  // Node id.
  id: string;
  // Node label.
  label: string;
  index: number;
  colValues: number[];
  colStrs: string[];
  colHidden: boolean[];
  colBgColors: string[];
  colTextColors: string[];
}

interface StatRow {
  stat: string;
  values: number[];
}

const CATEGORY_STAT_LABELS = ['sum', 'avg', 'min', 'max', 'pct'];

interface CategoryStatRow {
  category: string;
  // colValues[runIndex] = map from stat label to {value, bgColor, textColor}
  colValues: Array<Record<string, {value: number; bgColor: string; textColor: string}> | null>;
}

interface Stat {
  min: number;
  max: number;
  sum: number;
  count: number;
}

interface Col {
  // tslint:disable-next-line:no-any Allow arbitrary types.
  value: any;
  strValue: string;
  bgColor: string;
  textColor: string;
}

interface RunItem {
  runId: string;
  runName: string;
  done: boolean;
  error?: string;
  hideInAggregatedStatsTable?: boolean;
}

interface ChildrenStatsCol {
  colIndex: number;
  runIndex: number;
  label: string;
  hideInChildrenStatsTable?: boolean;
  multiLineHeader?: boolean;
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

interface NodeStatRow {
  id: string;
  label: string;
  index: number;
  isInput?: boolean;
  isOutput?: boolean;
  sourceSsa?: string;
  runValues: Array<{
    strValue: string;
    bgColor: string;
    textColor: string;
    hidden: boolean;
    rawValue: any; // tslint:disable-next-line:no-any
  }>;
}

// Matches the heatColor() scheme in src/Viewer/OverlayJsonWriter.cpp.
function heatColor(ratio: number): string {
  if (ratio >= 0.85) return '#ff4d4d';
  if (ratio >= 0.65) return '#ff9f40';
  if (ratio >= 0.40) return '#ffd666';
  return '#fff3bf';
}

function heatTextColor(ratio: number): string {
  // Only the top bucket (#ff4d4d red) needs white text; lighter backgrounds
  // are readable with black.
  return ratio >= 0.85 ? '#ffffff' : '#000000';
}

const CHILDREN_STATS = ['Sum %'];
const NODE_STAT_LABELS = ['percentage', 'specific'];

/** The panel to show node data provider summary for certain layouer. */
@Component({
  standalone: true,
  selector: 'node-data-provider-summary-panel',
  imports: [
    CommonModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
    Paginator,
    FormsModule,
    ReactiveFormsModule,
  ],
  templateUrl: 'node_data_provider_summary_panel.ng.html',
  styleUrls: ['./node_data_provider_summary_panel.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NodeDataProviderSummaryPanel implements OnChanges {
  @Input({required: true}) paneId!: string;
  @Input('rootGroupNodeId') rootGroupNodeId?: string;
  @ViewChild('paginator') paginator?: Paginator;
  @ViewChild('nodeStatsPaginator') nodeStatsPaginator?: Paginator;

  readonly nodeStatsTableNodeFilter = new FormControl<string>('');

  curRows?: Row[];
  curStatRows: StatRow[] = [];
  curCategoryStatRows: CategoryStatRow[] = [];
  savedCurCategoryStatRows: CategoryStatRow[] = [];
  readonly categoryStatLabels = CATEGORY_STAT_LABELS;
  selectedCategoryStat = CATEGORY_STAT_LABELS[0];
  curChildrenStatRows: ChildrenStatRow[] = [];
  runItems: RunItem[] = [];
  curSelectedRunId = '';
  orderedNodes: OpNode[] = [];
  childrenStatsCols: ChildrenStatsCol[] = [];
  tablePageSize = 50;
  selectedNodeStat: string = NODE_STAT_LABELS[1]; // 'specific'
  readonly nodeStatLabels = NODE_STAT_LABELS;
  curNodeStatRows: NodeStatRow[] = [];
  curPageNodeStatRows: NodeStatRow[] = [];
  savedNodeStatRows: NodeStatRow[] = [];

  private curModelGraph?: ModelGraph;
  private prevModelGraph?: ModelGraph;
  private prevRunsKey = '';
  private prevTheme = '';
  // "Model graph collection + id + root group node id" to ordered nodes.
  private readonly orderedNodesCache: Record<string, OpNode[]> = {};

  private readonly visualizerThemeService = inject(VisualizerThemeService);

  constructor(
    private readonly appService: AppService,
    private readonly destroyRef: DestroyRef,
    private readonly infoPanelService: InfoPanelService,
    private readonly nodeDataProviderExtensionService: NodeDataProviderExtensionService,
    private readonly changeDetectorRef: ChangeDetectorRef,
  ) {
    // For testing.
    const params = new URLSearchParams(document.location.search);
    if (params.has('nodeDataProviderDataSummaryTablePageSize')) {
      this.tablePageSize = Number(
        params.get('nodeDataProviderDataSummaryTablePageSize'),
      );
    }

    // Update the currently selected run id.
    effect(() => {
      const modelGraph = this.appService.getPaneById(this.paneId)?.modelGraph;
      if (!modelGraph) {
        return;
      }
      const selectedRun =
        this.nodeDataProviderExtensionService.getSelectedRunForModelGraph(
          this.paneId,
          modelGraph,
        );
      this.curSelectedRunId = selectedRun?.runId || '';
      this.changeDetectorRef.markForCheck();
    });

    effect(() => {
      const curTheme = this.appService.theme();
      let themeChanged = false;
      if (this.prevTheme !== curTheme) {
        themeChanged = true;
        this.prevTheme = curTheme;
      }

      this.curModelGraph = this.appService.getPaneById(this.paneId)?.modelGraph;
      const runs = this.curModelGraph
        ? this.nodeDataProviderExtensionService.getRunsForModelGraph(
            this.curModelGraph,
          )
        : [];

      let modelGraphChanged = false;
      let runsChanged = false;
      if (this.prevModelGraph !== this.curModelGraph) {
        this.prevModelGraph = this.curModelGraph;
        modelGraphChanged = true;
      }
      const curRunsKey = this.getRunsKey(runs);
      if (this.prevRunsKey !== curRunsKey) {
        this.prevRunsKey = curRunsKey;
        runsChanged = true;
      }

      if (
        this.curModelGraph &&
        (modelGraphChanged || runsChanged || themeChanged)
      ) {
        // Update run items in the index panel.
        this.runItems = [];
        const runs = this.nodeDataProviderExtensionService.getRunsForModelGraph(
          this.curModelGraph,
        );
        for (const run of runs) {
          this.runItems.push({
            runId: run.runId,
            runName: this.getRunName(run),
            done: run.done,
            error: run.error,
            hideInAggregatedStatsTable: (run.nodeDataProviderData ?? {})[
              this.curModelGraph.id
            ]?.hideInAggregatedStatsTable,
          });
        }
        this.changeDetectorRef.markForCheck();

        if (runs.length > 0) {
          this.infoPanelService.curNodeStatSortingColIndex = Math.min(
            this.infoPanelService.curNodeStatSortingColIndex,
            runs.length - 1,
          );
        }
        this.paginator?.reset();
        this.genOrderedNodes();
        this.populateResultsTable();
        this.nodeStatsPaginator?.reset();
      }
    });

    // Handle changes on node stats table node filter.
    this.nodeStatsTableNodeFilter.valueChanges
      .pipe(debounceTime(150), takeUntilDestroyed(this.destroyRef))
      .subscribe((text) => {
        this.nodeStatsPaginator?.reset();
        this.sortAndFilterNodeStatRows();
        this.handleNodeStatsTablePaginatorChanged(0);
      });
  }

  ngOnChanges(changes: SimpleChanges) {
    if (changes['rootGroupNodeId']) {
      this.paginator?.reset();
      this.nodeStatsPaginator?.reset();
      this.genOrderedNodes();
      this.populateResultsTable();
    }
  }

  getIconName(runItem: RunItem): string {
    return this.isRunItemSelected(runItem) ? 'visibility' : 'visibility_off';
  }

  getVisibleToggleTooltip(runItem: RunItem): string {
    return this.isRunItemSelected(runItem)
      ? 'Visualizing in graph'
      : 'Click to visualize in graph';
  }

  isRunItemSelected(runItem: RunItem): boolean {
    return runItem.runId === this.curSelectedRunId;
  }

  handleNodeStatsTablePaginatorChanged(curPageIndex: number) {
    this.curPageNodeStatRows = this.curNodeStatRows.slice(
      curPageIndex * this.tablePageSize,
      (curPageIndex + 1) * this.tablePageSize,
    );
    this.changeDetectorRef.markForCheck();
  }

  handleNodeStatChanged() {
    this.infoPanelService.curNodeStatSortingColIndex =
      this.selectedNodeStat === 'percentage' ? this.childrenStatsCols.length - 1 : 0;
    this.infoPanelService.curNodeStatSortingDirection = 'desc';
    this.rebuildNodeStatRows();
    this.nodeStatsPaginator?.reset();
    this.handleNodeStatsTablePaginatorChanged(0);
  }

  handleClickNodeStatsHeader(colIndex: number) {
    if (this.infoPanelService.curNodeStatSortingColIndex === colIndex) {
      this.infoPanelService.curNodeStatSortingDirection =
        this.nextSortingDirection(
          this.infoPanelService.curNodeStatSortingDirection,
        );
    } else {
      this.infoPanelService.curNodeStatSortingDirection =
        colIndex < 0 ? 'asc' : 'desc';
    }

    this.infoPanelService.curNodeStatSortingColIndex = colIndex;
    this.sortAndFilterNodeStatRows();

    this.nodeStatsPaginator?.reset();
    this.handleNodeStatsTablePaginatorChanged(0);
  }

  handleCategoryStatChanged() {
    this.sortAndFilterCategoryStatsRows();
  }

  handleClickCategoryStatsHeader(colIndex: number) {
    if (this.infoPanelService.curCategoryStatSortingColIndex === colIndex) {
      this.infoPanelService.curCategoryStatSortingDirection =
        this.nextSortingDirection(
          this.infoPanelService.curCategoryStatSortingDirection,
        );
    } else {
      this.infoPanelService.curCategoryStatSortingDirection =
        colIndex < 0 ? 'asc' : 'desc';
    }

    this.infoPanelService.curCategoryStatSortingColIndex = colIndex;
    this.sortAndFilterCategoryStatsRows();
  }

  handleClickToggleVisibility(runItem: RunItem, event: Event) {
    event.stopPropagation();

    if (this.isRunItemSelected(runItem)) {
      return;
    }
    this.appService.setSelectedNodeDataProviderRunId(
      this.paneId,
      runItem.runId,
    );
  }

  handleClickDelete(runItem: RunItem) {
    if (!this.curModelGraph) {
      return;
    }

    this.nodeDataProviderExtensionService.deleteRun(runItem.runId);
    this.appService.deleteShowOnNodeItemType([
      `${NODE_DATA_PROVIDER_SHOW_ON_NODE_TYPE_PREFIX}${runItem.runName}`,
    ]);
  }

  handleClickNodeLabel(nodeId: string) {
    this.appService.curToLocateNodeInfo.set({
      nodeId,
      // Locate node in the main renderer in the current pane. Its renderer id
      // is the same as the pane id.
      rendererId: this.paneId,
      isGroupNode: false,
    });
  }

  handleToggleExpandCollapseStatsTable(tableContainer: HTMLElement) {
    if (!this.infoPanelService.statsTableCollapsed) {
      tableContainer.style.maxHeight = `${tableContainer.offsetHeight}px`;
    } else {
      tableContainer.style.maxHeight = `${tableContainer.scrollHeight}px`;
    }
    this.changeDetectorRef.markForCheck();

    setTimeout(() => {
      this.infoPanelService.statsTableCollapsed =
        !this.infoPanelService.statsTableCollapsed;
      this.changeDetectorRef.markForCheck();

      if (!this.infoPanelService.statsTableCollapsed) {
        setTimeout(() => {
          tableContainer.style.maxHeight = 'fit-content';
        }, 150);
      }
    });
  }

  handleToggleExpandCollapseCategoryStatsTable(tableContainer: HTMLElement) {
    if (!this.infoPanelService.categoryStatsTableCollapsed) {
      tableContainer.style.maxHeight = `${tableContainer.offsetHeight}px`;
    } else {
      tableContainer.style.maxHeight = `${tableContainer.scrollHeight}px`;
    }
    this.changeDetectorRef.markForCheck();

    setTimeout(() => {
      this.infoPanelService.categoryStatsTableCollapsed =
        !this.infoPanelService.categoryStatsTableCollapsed;
      this.changeDetectorRef.markForCheck();

      if (!this.infoPanelService.categoryStatsTableCollapsed) {
        setTimeout(() => {
          tableContainer.style.maxHeight = 'fit-content';
        }, 150);
      }
    });
  }

  handleToggleExpandCollapseNodeStatsTable(tableContainer: HTMLElement) {
    if (!this.infoPanelService.nodeStatsTableCollapsed) {
      tableContainer.style.maxHeight = `${tableContainer.offsetHeight}px`;
    } else {
      tableContainer.style.maxHeight = `${tableContainer.scrollHeight}px`;
    }
    this.changeDetectorRef.markForCheck();

    setTimeout(() => {
      this.infoPanelService.nodeStatsTableCollapsed =
        !this.infoPanelService.nodeStatsTableCollapsed;
      this.changeDetectorRef.markForCheck();

      if (!this.infoPanelService.nodeStatsTableCollapsed) {
        setTimeout(() => {
          tableContainer.style.maxHeight = 'fit-content';
        }, 150);
      }
    });
  }

  handleClearStatsTableFilter(formControl: FormControl<string>) {
    if (formControl === this.nodeStatsTableNodeFilter) {
      this.nodeStatsPaginator?.reset();
    }

    formControl.reset();
  }

  getStatValue(value: number): string {
    if (
      value === Number.POSITIVE_INFINITY ||
      value === Number.NEGATIVE_INFINITY ||
      isNaN(value)
    ) {
      return '-';
    }
    return `${value}`;
  }

  getHideStatsTableCol(index: number): boolean {
    return this.runItems[index]?.hideInAggregatedStatsTable === true;
  }

  getCategoryColHidden(colIndex: number): boolean {
    return this.runItems[colIndex]?.hideInAggregatedStatsTable === true;
  }

  getCategoryStatValue(row: CategoryStatRow, runIndex: number): string {
    const vals = row.colValues[runIndex];
    if (!vals) return '-';
    const info = vals[this.selectedCategoryStat];
    if (!info) return '-';
    if (
      info.value === Number.POSITIVE_INFINITY ||
      info.value === Number.NEGATIVE_INFINITY ||
      isNaN(info.value)
    ) {
      return '-';
    }
    if (this.selectedCategoryStat === 'pct') {
      return `${info.value.toFixed(1)}%`;
    }
    return `${info.value}`;
  }

  getCategoryStatBgColor(row: CategoryStatRow, runIndex: number): string {
    const vals = row.colValues[runIndex];
    if (!vals) return '';
    // For 'pct', use sum's bgColor since pct is derived from sum.
    const stat = this.selectedCategoryStat === 'pct' ? 'sum' : this.selectedCategoryStat;
    const info = vals[stat];
    return info ? info.bgColor : '';
  }

  getCategoryStatTextColor(row: CategoryStatRow, runIndex: number): string {
    const vals = row.colValues[runIndex];
    if (!vals) return '';
    const stat = this.selectedCategoryStat === 'pct' ? 'sum' : this.selectedCategoryStat;
    const info = vals[stat];
    return info?.textColor || '';
  }

  trackByRunId(index: number, runItem: RunItem): string {
    return runItem.runId;
  }

  trackByNodeId(index: number, row: {id: string}): string {
    return row.id;
  }

  trackByStat(index: number, row: StatRow): string {
    return row.stat;
  }

  trackByCategory(index: number, row: CategoryStatRow): string {
    return row.category;
  }

  get showResults(): boolean {
    return this.runItems.some((runItem) => runItem.done);
  }

  get nodeStatRowsCount(): number {
    return this.curNodeStatRows.length;
  }

  get statsTableTitleIcon(): string {
    return this.statsTableCollapsed ? 'arrow_right' : 'arrow_drop_down';
  }

  get statsTableTitle(): string {
    if (this.rootGroupNodeId == null) {
      return 'Aggregated stats';
    }
    return 'Aggregated stats in selected layer';
  }

  get statsTableCollapsed(): boolean {
    return this.infoPanelService.statsTableCollapsed;
  }

  get categoryStatsTableTitleIcon(): string {
    return this.categoryStatsTableCollapsed ? 'arrow_right' : 'arrow_drop_down';
  }

  get categoryStatsTableTitle(): string {
    return 'Category stats';
  }

  get nodeStatsTableTitleIcon(): string {
    return this.nodeStatsTableCollapsed ? 'arrow_right' : 'arrow_drop_down';
  }

  get nodeStatsTableTitle(): string {
    if (this.rootGroupNodeId == null) {
      return 'Node stats';
    }
    return 'Node stats in selected layer';
  }

  get nodeStatsTableCollapsed(): boolean {
    return this.infoPanelService.nodeStatsTableCollapsed;
  }

  get curNodeStatSortingDirection(): SortingDirection {
    return this.infoPanelService.curNodeStatSortingDirection;
  }

  get curNodeStatSortingColIndex(): number {
    return this.infoPanelService.curNodeStatSortingColIndex;
  }

  get curCategoryStatSortingDirection(): SortingDirection {
    return this.infoPanelService.curCategoryStatSortingDirection;
  }

  get curCategoryStatSortingColIndex(): number {
    return this.infoPanelService.curCategoryStatSortingColIndex;
  }

  get showStatsTable(): boolean {
    if (!this.curModelGraph) {
      return false;
    }

    const runs = this.nodeDataProviderExtensionService.getRunsForModelGraph(
      this.curModelGraph,
    );
    let hide = true;
    for (const run of runs) {
      if (!run.nodeDataProviderData) {
        continue;
      }
      const curData = run.nodeDataProviderData[this.curModelGraph.id];
      if (!curData.hideInAggregatedStatsTable) {
        hide = false;
        break;
      }
    }
    return !hide;
  }

  get showCategoryStatsTable(): boolean {
    if (!this.curModelGraph) return false;
    return this.curCategoryStatRows.length > 0;
  }

  get categoryStatsTableCollapsed(): boolean {
    return this.infoPanelService.categoryStatsTableCollapsed;
  }

  get showNodeStatsTable(): boolean {
    if (!this.curModelGraph) return false;
    const runs = this.nodeDataProviderExtensionService.getRunsForModelGraph(
      this.curModelGraph,
    );
    if (runs.length === 0) return false;
    // Always show when there are runs; rows populate after data loads.
    return true;
  }

  get fontSize(): number {
    return this.appService.config()?.infoPanelFontSize ?? 12;
  }

  get showChildrenStatsCols(): boolean {
    return this.selectedNodeStat === 'percentage';
  }

  private genOrderedNodes() {
    if (!this.curModelGraph) {
      return;
    }

    const cacheKey = this.getOrderedNodesCacheKey();
    const cachedOrderedNodes = this.orderedNodesCache[cacheKey];
    if (cachedOrderedNodes != null) {
      this.orderedNodes = cachedOrderedNodes;
    } else {
      const rootGroupNode: GroupNode | undefined =
        this.rootGroupNodeId == null
          ? undefined
          : (this.curModelGraph.nodesById[this.rootGroupNodeId] as GroupNode);
      let nodeIdsInRootGroupNode = new Set<string>();
      if (rootGroupNode != null) {
        nodeIdsInRootGroupNode = new Set<string>(
          rootGroupNode.descendantsOpNodeIds || [],
        );
      }
      this.orderedNodes = this.curModelGraph.nodes.filter(
        (node) =>
          isOpNode(node) &&
          !node.hideInLayout &&
          node.id !== 'GraphInputs' &&
          node.id !== 'GraphOutputs' &&
          (rootGroupNode == null || nodeIdsInRootGroupNode.has(node.id)),
      ) as OpNode[];
      this.orderedNodesCache[cacheKey] = this.orderedNodes;
    }
  }

  private populateResultsTable() {
    if (!this.curModelGraph || this.orderedNodes.length === 0) {
      return;
    }
    const runs = this.nodeDataProviderExtensionService.getRunsForModelGraph(
      this.curModelGraph,
    );

    this.curStatRows = [
      {stat: 'Min', values: []},
      {stat: 'Max', values: []},
      {stat: 'Sum', values: []},
      {stat: 'Avg', values: []},
    ];
    const stats: Stat[] = [];
    for (let i = 0; i < runs.length; i++) {
      stats.push({
        min: Number.POSITIVE_INFINITY,
        max: Number.NEGATIVE_INFINITY,
        sum: 0,
        count: 0,
      });
    }

    this.curRows = [];
    for (let i = 0; i < this.orderedNodes.length; i++) {
      const node = this.orderedNodes[i];
      const nodeId = node.id;
      const cols: Col[] = [];
      for (let j = 0; j < runs.length; j++) {
        const run = runs[j];
        const curResults = run.results || {};
        const nodeResult = (curResults[this.curModelGraph.id] || {})[nodeId];
        // tslint:disable-next-line:no-any Allow arbitrary types.
        const value: any = nodeResult?.value;
        const strValue = nodeResult?.strValue || '-';
        const bgColor = nodeResult?.bgColor || '';
        const textColor =
          nodeResult?.textColor ||
          this.visualizerThemeService.getColor(ColorVariable.ON_SURFACE_COLOR);
        cols.push({value, strValue, bgColor, textColor});

        // Update stats.
        if (value != null && typeof value === 'number') {
          const curStat = stats[j];
          // min.
          curStat.min = Math.min(value, curStat.min);
          // max.
          curStat.max = Math.max(value, curStat.max);
          // count.
          curStat.count++;
          // sum.
          curStat.sum += value;
        }
      }
      const incomingEdges = node.incomingEdges || [];
      const isInput =
        incomingEdges.length === 0 ||
        incomingEdges.some((edge) => edge.sourceNodeId === 'GraphInputs');
      const outgoingEdges = node.outgoingEdges || [];
      const isOutput =
        outgoingEdges.length === 0 ||
        outgoingEdges.some((edge) => edge.targetNodeId === 'GraphOutputs');
      const graphNode = this.curModelGraph.nodesById[nodeId] as OpNode;
      const sourceSsa =
        (graphNode.attrs?.['mdbg_source_ssa'] as string) || undefined;
      this.curRows.push({
        id: nodeId,
        index: i,
        isInput,
        isOutput,
        sourceSsa,
        label: graphNode.label || '?',
        cols,
      });
    }

    // Populate stat rows.
    this.curStatRows[0].values = stats.map((stat) => stat.min);
    this.curStatRows[1].values = stats.map((stat) => stat.max);
    this.curStatRows[2].values = stats.map((stat) => stat.sum);
    this.curStatRows[3].values = stats.map((stat) => stat.sum / stat.count);

    // Hide stat values based on hideAggregatedStats.
    const allStats: AggregatedStat[] = ['min', 'max', 'sum', 'avg'];
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i];
      const statsToHide: AggregatedStat[] =
        run.nodeDataProviderData?.[this.curModelGraph.id]
          ?.hideAggregatedStats ?? [];
      for (let j = 0; j < allStats.length; j++) {
        const stat = allStats[j];
        if (statsToHide.includes(stat)) {
          // Set the value to positive infinity so that it will be displayed as
          // '-' in the table. See `getStatValue()`.
          this.curStatRows[j].values[i] = Number.POSITIVE_INFINITY;
        }
      }
    }

    // Populate category stats from __cat__:category:stat prefixed results.
    this.curCategoryStatRows = [];
    const CAT_PREFIX = '__cat__:';
    // Collect per-category per-stat per-run values.
    const catStats: Record<
      string,
      Record<number, Record<string, {value: number; bgColor: string; textColor: string}>>
    > = {};
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i];
      const curResults = run.results || {};
      const graphResults = curResults[this.curModelGraph.id] || {};
      for (const [key, result] of Object.entries(graphResults)) {
        if (!key.startsWith(CAT_PREFIX)) continue;
        const parts: string[] = key.substring(CAT_PREFIX.length).split(':');
        if (parts.length !== 2) continue;
        const category = parts[0];
        const stat = parts[1]; // sum, avg, min, max
        const castResult = result as {value?: unknown; bgColor?: string; textColor?: string};
        const value = castResult?.value;
        if (typeof value !== 'number') continue;
        const bgColor = castResult?.bgColor || '';
        const textColor = castResult?.textColor || '';
        if (!catStats[category]) catStats[category] = {};
        if (!catStats[category][i]) catStats[category][i] = {};
        catStats[category][i][stat] = {value, bgColor, textColor};
      }
    }
    // Build rows, one per category.
    for (const [category, runStats] of Object.entries(catStats)) {
      const row: CategoryStatRow = {
        category,
        colValues: new Array(runs.length).fill(null),
      };
      for (let i = 0; i < runs.length; i++) {
        row.colValues[i] = runStats[i] || null;
      }
      this.curCategoryStatRows.push(row);
    }

    // Compute per-run totals for 'sum' and inject 'pct' values.
    const runSums: number[] = new Array(runs.length).fill(0);
    for (const row of this.curCategoryStatRows) {
      for (let i = 0; i < runs.length; i++) {
        const vals = row.colValues[i];
        if (vals?.['sum']) runSums[i] += vals['sum'].value;
      }
    }
    for (const row of this.curCategoryStatRows) {
      for (let i = 0; i < runs.length; i++) {
        const vals = row.colValues[i];
        if (!vals) continue;
        const sumVal = vals['sum'] ? vals['sum'].value : 0;
        const pct = runSums[i] > 0 ? (sumVal / runSums[i]) * 100 : 0;
        vals['pct'] = {value: pct, bgColor: vals['sum']?.bgColor || '', textColor: vals['sum']?.textColor || ''};
      }
    }

    this.savedCurCategoryStatRows = [...this.curCategoryStatRows];
    this.sortAndFilterCategoryStatsRows();

    // Generate children stats columns.
    this.childrenStatsCols = [];
    let childrenStatColIndex = 0;
    const groupNode = this.curModelGraph.nodesById[
      this.rootGroupNodeId ?? ''
    ] as GroupNode;
    const runIdToValueInfos: Record<string, NodeDataProviderValueInfo[]> = {};
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i];
      let childrenStats = CHILDREN_STATS;
      let valueInfos: NodeDataProviderValueInfo[] = [];
      let multiLineHeader = false;
      if (
        (run.nodeDataProviderData ?? {})[this.curModelGraph.id]
          ?.showLabelCountColumnsInChildrenStatsTable
      ) {
        valueInfos = genSortedValueInfos(
          groupNode,
          this.curModelGraph,
          (run.results ?? {})[this.curModelGraph.id],
        ).sort((a, b) => a.label.localeCompare(b.label));
        runIdToValueInfos[run.runId] = valueInfos;
        childrenStats = valueInfos.map((valueInfo) => `#${valueInfo.label}`);
        multiLineHeader = true;
      }
      for (const childrenStat of childrenStats) {
        let label = childrenStat;
        if (runs.length > 1) {
          if (multiLineHeader) {
            label = `${this.getRunName(runs[i])}\n${childrenStat}`;
          } else {
            label = `${this.getRunName(runs[i])} • ${childrenStat}`;
          }
        }
        this.childrenStatsCols.push({
          colIndex: childrenStatColIndex,
          runIndex: i,
          label,
          hideInChildrenStatsTable:
            runs[i].nodeDataProviderData?.[this.curModelGraph.id]
              ?.hideInChildrenStatsTable,
          multiLineHeader,
        });
        childrenStatColIndex++;
      }
    }

    // Populate children stats rows.
    this.curChildrenStatRows = [];
    const nsChildrenIds = this.rootGroupNodeId
      ? (this.curModelGraph.nodesById[this.rootGroupNodeId] as GroupNode)
          .nsChildrenIds || []
      : this.curModelGraph.rootNodes.map((node) => node.id);
    for (let i = 0; i < nsChildrenIds.length; i++) {
      const nodeId = nsChildrenIds[i];
      const node = this.curModelGraph.nodesById[nodeId];
      const colValues: number[] = [];
      const colStrs: string[] = [];
      const colHidden: boolean[] = [];
      for (let runIndex = 0; runIndex < runs.length; runIndex++) {
        const run = runs[runIndex];
        const curResults = run.results || {};
        // Sum pct.
        if (!runIdToValueInfos[run.runId]) {
          let sumPct = 0;
          let hasValue = false;
          if (isOpNode(node)) {
            const nodeResult = (curResults[this.curModelGraph.id] || {})[
              nodeId
            ];
            const value = nodeResult?.value;
            if (value != null && typeof value === 'number') {
              sumPct = (value / stats[runIndex].sum) * 100;
              hasValue = true;
            }
          } else if (isGroupNode(node)) {
            let layerSum = 0;
            const childrenIds = node.descendantsOpNodeIds || [];
            for (const childNodeId of childrenIds) {
              const nodeResult = (curResults[this.curModelGraph.id] || {})[
                childNodeId
              ];
              const value = nodeResult?.value;
              if (value != null && typeof value === 'number') {
                layerSum += value;
                hasValue = true;
              }
            }
            sumPct = (layerSum / stats[runIndex].sum) * 100;
          }
          colValues.push(sumPct);
          colStrs.push(hasValue ? sumPct.toFixed(1) : '-');
          colHidden.push(
            run.nodeDataProviderData?.[this.curModelGraph.id]
              ?.hideInChildrenStatsTable === true,
          );
        }
        // Label counts.
        else {
          const valueInfos = runIdToValueInfos[run.runId];
          const curResults = run.results || {};
          const nodeResult = (curResults[this.curModelGraph.id] || {})[nodeId];
          const value = nodeResult?.value || '';
          for (const valueInfo of valueInfos) {
            let count = 0;
            if (isOpNode(node)) {
              if (valueInfo.label === value) {
                count = 1;
              }
            } else if (isGroupNode(node)) {
              const childrenIds = node.descendantsOpNodeIds || [];
              for (const childNodeId of childrenIds) {
                const nodeResult = (curResults[this.curModelGraph.id] || {})[
                  childNodeId
                ];
                const childValue = nodeResult?.value || '';
                if (childValue === valueInfo.label) {
                  count++;
                }
              }
            }
            colValues.push(count);
            colStrs.push(`${count}`);
            colHidden.push(
              run.nodeDataProviderData?.[this.curModelGraph.id]
                ?.hideInChildrenStatsTable === true,
            );
          }
        }
      }
      this.curChildrenStatRows.push({
        id: nodeId,
        label: node.label,
        index: i,
        colValues,
        colStrs,
        colHidden,
        colBgColors: new Array(colValues.length).fill(''),
        colTextColors: new Array(colValues.length).fill(''),
      });
    }

    // Apply heatmap colors to children stat rows.
    this.applyHeatmapToChildrenStatRows(this.curChildrenStatRows);

    // Build unified NodeStatRow data.
    this.rebuildNodeStatRows();

    this.changeDetectorRef.markForCheck();
  }

  private rebuildNodeStatRows() {
    if (this.selectedNodeStat === 'percentage') {
      this.curNodeStatRows = this.convertChildrenStatRowsToNodeStatRows(
        this.curChildrenStatRows,
      );
    } else {
      this.curNodeStatRows = this.convertRowsToNodeStatRows(
        this.curRows || [],
      );
    }
    this.savedNodeStatRows = [...this.curNodeStatRows];
    this.sortAndFilterNodeStatRows();
    this.handleNodeStatsTablePaginatorChanged(0);
  }

  private convertRowsToNodeStatRows(rows: Row[]): NodeStatRow[] {
    return rows
      .map((row) => ({
        id: row.id,
        label: row.label,
        index: row.index,
        isInput: row.isInput,
        isOutput: row.isOutput,
        sourceSsa: row.sourceSsa,
        runValues: row.cols.map((col, colIndex) => ({
          strValue: col.strValue,
          bgColor: col.bgColor,
          textColor: col.textColor,
          hidden:
            this.runItems[colIndex]?.hideInAggregatedStatsTable === true,
          rawValue: col.value,
        })),
      }))
      .filter((row) => this.hasVisibleNodeStatValue(row));
  }

  private hasVisibleNodeStatValue(row: NodeStatRow): boolean {
    return row.runValues.some((value) => {
      if (value.hidden) {
        return false;
      }
      if (value.rawValue != null) {
        return true;
      }
      return value.strValue !== '' && value.strValue !== '-';
    });
  }

  // Computes heatmap colors for all children stat rows, per run, and writes
  // them into each row's colBgColors / colTextColors arrays.
  private applyHeatmapToChildrenStatRows(rows: ChildrenStatRow[]) {
    if (rows.length === 0) return;
    const runs = this.nodeDataProviderExtensionService.getRunsForModelGraph(
      this.curModelGraph!,
    );

    for (let runIndex = 0; runIndex < runs.length; runIndex++) {
      const run = runs[runIndex];
      const graphData = run?.nodeDataProviderData?.[this.curModelGraph!.id];

      // Find the "Sum %" column index for this run.
      const colIndex = this.childrenStatsCols.findIndex(
        (c) => c.runIndex === runIndex && !c.hideInChildrenStatsTable,
      );
      if (colIndex < 0) continue;

      // Compute min/max across rows with actual values (not '-').
      let min = Number.POSITIVE_INFINITY;
      let max = Number.NEGATIVE_INFINITY;
      for (const row of rows) {
        if (row.colHidden[colIndex]) continue;
        if (row.colStrs[colIndex] === '-') continue;
        const v = row.colValues[colIndex];
        if (typeof v === 'number' && !isNaN(v)) {
          min = Math.min(min, v);
          max = Math.max(max, v);
        }
      }

      // Use data-source gradient/threshold if configured, else match the
      // C++ heatColor() scheme from OverlayJsonWriter.
      const gradient = graphData?.gradient;
      const thresholds = graphData?.thresholds;
      const hasCustom = (gradient && gradient.length > 0) || (thresholds && thresholds.length > 0);

      for (const row of rows) {
        // Align with specific tab: rows showing '-' have no data, skip coloring.
        if (row.colStrs[colIndex] === '-') continue;
        const v = row.colValues[colIndex];
        if (typeof v !== 'number' || isNaN(v)) continue;
        let bgColor: string;
        let textColor: string;
        if (hasCustom) {
          const processedGradient = this.processGradient(gradient);
          bgColor = this.valueToBgColor(
            v, thresholds || [], processedGradient, min, max,
          );
          textColor = this.valueToTextColor(
            v, thresholds || [], processedGradient, min, max, bgColor,
          );
        } else {
          const ratio = max > min ? (v - min) / (max - min) : 0;
          bgColor = heatColor(ratio);
          textColor = heatTextColor(ratio);
        }
        row.colBgColors[colIndex] = bgColor;
        row.colTextColors[colIndex] = textColor;
      }
    }
  }

  private processGradient(
    gradient?: GradientItem[],
  ): Array<{stop: number; bgColor?: Rgb; textColor?: Rgb}> {
    if (!gradient || gradient.length === 0) return [];
    return gradient
      .map((g) => ({
        stop: g.stop,
        bgColor: this.getRgbFromColor(g.bgColor || '', '#ffffff'),
        textColor: this.getRgbFromColor(g.textColor || '', '#000000'),
      }))
      .sort((a, b) => a.stop - b.stop);
  }

  private valueToBgColor(
    value: number,
    thresholds: ThresholdItem[],
    gradient: Array<{stop: number; bgColor?: Rgb; textColor?: Rgb}>,
    min: number,
    max: number,
  ): string {
    if (gradient.length > 0 && max > min) {
      return this.interpolateGradientColor(
        value,
        gradient,
        min,
        max,
        true,
        'transparent',
      );
    }
    for (const t of thresholds) {
      if (value <= t.value) return t.bgColor;
    }
    return 'transparent';
  }

  private valueToTextColor(
    value: number,
    thresholds: ThresholdItem[],
    gradient: Array<{stop: number; bgColor?: Rgb; textColor?: Rgb}>,
    min: number,
    max: number,
    bgColor: string,
  ): string {
    if (gradient.length > 0 && max > min) {
      return this.interpolateGradientColor(
        value,
        gradient,
        min,
        max,
        false,
        '',
      );
    }
    for (const t of thresholds) {
      if (value <= t.value) return t.textColor || '';
    }
    // Auto-detect text color based on bg luminance for dark backgrounds.
    if (bgColor && bgColor !== 'transparent') {
      const rgb = this.getRgbFromColor(bgColor, '#ffffff');
      if (rgb) {
        const luminance =
          Math.pow(rgb.r / 255.0, 2.2) * 0.2126 +
          Math.pow(rgb.g / 255.0, 2.2) * 0.7152 +
          Math.pow(rgb.b / 255.0, 2.2) * 0.0722;
        return luminance < 0.38 ? '#ffffff' : '#1f1f1f';
      }
    }
    return '';
  }

  private interpolateGradientColor(
    value: number,
    gradient: Array<{stop: number; bgColor?: Rgb; textColor?: Rgb}>,
    min: number,
    max: number,
    isBgColor: boolean,
    defaultColor: string,
  ): string {
    const targetStop = (value - min) / (max - min);
    for (let i = 0; i < gradient.length - 1; i++) {
      const cur = gradient[i];
      const next = gradient[i + 1];
      const curColor = isBgColor ? cur.bgColor : cur.textColor;
      const nextColor = isBgColor ? next.bgColor : next.textColor;
      if (targetStop >= cur.stop && targetStop <= next.stop) {
        if (!curColor || !nextColor) return defaultColor;
        const ratio = (targetStop - cur.stop) / (next.stop - cur.stop);
        const r = Math.floor(curColor.r + (nextColor.r - curColor.r) * ratio);
        const g = Math.floor(curColor.g + (nextColor.g - curColor.g) * ratio);
        const b = Math.floor(curColor.b + (nextColor.b - curColor.b) * ratio);
        return `#${this.numToHex(r)}${this.numToHex(g)}${this.numToHex(b)}`;
      }
    }
    return defaultColor;
  }

  private getRgbFromColor(
    color: string,
    defaultColor: string,
  ): Rgb | undefined {
    let hex = color;
    if (!color.startsWith('#')) {
      hex = COLOR_NAME_TO_HEX[color] || '';
    }
    if (!hex) hex = defaultColor;
    hex = hex.replace('#', '');
    if (hex.length === 3) hex = hex.repeat(2);
    return {
      r: this.hexStrToInt(hex.substring(0, 2)),
      g: this.hexStrToInt(hex.substring(2, 4)),
      b: this.hexStrToInt(hex.substring(4, 6)),
    };
  }

  private numToHex(x: number): string {
    const hex = x.toString(16);
    return hex.length === 1 ? `0${hex}` : hex;
  }

  private hexStrToInt(hex: string): number {
    return /^[a-fA-F0-9]+$/.test(hex) ? parseInt(hex, 16) : 255;
  }

  private convertChildrenStatRowsToNodeStatRows(
    rows: ChildrenStatRow[],
  ): NodeStatRow[] {
    return rows
      .map((row) => ({
        id: row.id,
        label: row.label,
        index: row.index,
        runValues: row.colValues.map((value, colIndex) => ({
          strValue: row.colStrs[colIndex] || '-',
          bgColor: row.colBgColors[colIndex] || '',
          textColor: row.colTextColors[colIndex] || '',
          hidden: row.colHidden[colIndex] || false,
          rawValue: value,
        })),
      }))
      .filter((row) => this.hasVisibleNodeStatValue(row));
  }

  private nextSortingDirection(direction: SortingDirection) {
    switch (direction) {
      case 'desc':
        return 'asc';
      case 'asc':
        return 'desc';
      default:
        return direction;
    }
  }

  private sortAndFilterNodeStatRows() {
    this.curNodeStatRows = [...(this.savedNodeStatRows || [])];

    // Filter.
    const regexText = (this.nodeStatsTableNodeFilter.value || '').trim();
    if (regexText !== '') {
      try {
        const regex = new RegExp(regexText, 'i');
        this.curNodeStatRows = this.curNodeStatRows.filter((row) =>
          regex.test(row.label) || (row.sourceSsa && regex.test(row.sourceSsa)),
        );
      } catch {
        return;
      }
    }

    // Sort.
    this.curNodeStatRows.sort((a, b) => {
      const v1 = this.getNodeStatColValue(
        a,
        this.infoPanelService.curNodeStatSortingColIndex,
      );
      const v2 = this.getNodeStatColValue(
        b,
        this.infoPanelService.curNodeStatSortingColIndex,
      );
      return this.compareValue(
        v1,
        v2,
        this.infoPanelService.curNodeStatSortingDirection,
      );
    });
  }

  private sortAndFilterCategoryStatsRows() {
    this.curCategoryStatRows = [...(this.savedCurCategoryStatRows || [])];

    // Sort.
    this.curCategoryStatRows.sort((a, b) => {
      const v1 = this.getCategoryStatsColValue(
        a,
        this.infoPanelService.curCategoryStatSortingColIndex,
      );
      const v2 = this.getCategoryStatsColValue(
        b,
        this.infoPanelService.curCategoryStatSortingColIndex,
      );
      return this.compareValue(
        v1,
        v2,
        this.infoPanelService.curCategoryStatSortingDirection,
      );
    });
  }

  private compareValue(
    v1: number | string | undefined,
    v2: number | string | undefined,
    direction: SortingDirection,
  ): number {
    if (v1 == null && v2 == null) {
      return 0;
    } else if (v1 == null && v2 != null) {
      return direction === 'asc' ? -1 : 1;
    } else if (v1 != null && v2 == null) {
      return direction === 'asc' ? 1 : -1;
    } else if (typeof v1 === 'number' && typeof v2 === 'number') {
      return direction === 'asc' ? v1 - v2 : v2 - v1;
    } else {
      const strV1 = JSON.stringify(v1);
      const strV2 = JSON.stringify(v2);
      return direction === 'asc'
        ? strV1.localeCompare(strV2)
        : strV2.localeCompare(strV1);
    }
  }

  private getNodeStatColValue(
    row: NodeStatRow,
    colIndex: number,
  ): string | number | undefined {
    switch (colIndex) {
      case -2:
        return row.index;
      case -1:
        return row.label;
      default:
        return row.runValues[colIndex]?.rawValue;
    }
  }

  private getCategoryStatsColValue(
    row: CategoryStatRow,
    colIndex: number,
  ): string | number | undefined {
    switch (colIndex) {
      case -2:
        // -2 (index column) is not meaningful for category stats; fall through to label.
      case -1:
        return row.category;
      default: {
        const vals = row.colValues[colIndex];
        if (!vals) return undefined;
        const info = vals[this.selectedCategoryStat === 'pct' ? 'pct' : this.selectedCategoryStat];
        return info ? info.value : undefined;
      }
    }
  }

  private getOrderedNodesCacheKey(): string {
    return `${this.curModelGraph?.collectionLabel}___${this.curModelGraph?.id}___${this.rootGroupNodeId}`;
  }

  private getRunsKey(runs: NodeDataProviderRunData[]): string {
    return runs
      .map((run) => {
        const parts: string[] = [];
        parts.push(run.runId);
        parts.push(String(run.done));
        const results = run.results || {};
        parts.push(String(Object.keys(results).length));
        return parts.join('__');
      })
      .join(',');
  }

  private getRunName(run: NodeDataProviderRunData): string {
    return getRunName(run, this.curModelGraph);
  }
}
