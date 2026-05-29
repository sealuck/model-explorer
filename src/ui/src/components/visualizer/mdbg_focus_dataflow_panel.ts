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
  ElementRef,
  inject,
  Input,
  QueryList,
  ViewChildren,
} from '@angular/core';
import {FormControl, ReactiveFormsModule} from '@angular/forms';
import {MatButtonModule} from '@angular/material/button';
import {MatIconModule} from '@angular/material/icon';

import {ModelGraph, ModelNode} from './common/model_graph';
import {isOpNode, isOutputsNode} from './common/utils';
import {
  importFromLines,
  SsaFileImportUnresolvedLine,
} from './ssa_file_importer';

const SSA_ATTR_KEY = 'mdbg_source_ssa';

function readAttr(node: ModelNode, key: string): string | undefined {
  if (!isOpNode(node) || node.attrs == null) {
    return undefined;
  }

  const attrs: unknown = node.attrs;
  if (Array.isArray(attrs)) {
    const attr = attrs.find((item) => {
      if (item == null || typeof item !== 'object') {
        return false;
      }
      return (item as Record<string, unknown>)['key'] === key;
    });
    const value =
      attr != null && typeof attr === 'object'
        ? (attr as Record<string, unknown>)['value']
        : undefined;
    return typeof value === 'string' ? value : undefined;
  }

  if (typeof attrs !== 'object') {
    return undefined;
  }
  const value = (attrs as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/** Toolbar panel for focusing dataflow from source SSA values. */
@Component({
  standalone: true,
  selector: 'mdbg-focus-dataflow-panel',
  imports: [
    CommonModule,
    MatButtonModule,
    MatIconModule,
    ReactiveFormsModule,
  ],
  templateUrl: './mdbg_focus_dataflow_panel.ng.html',
  styleUrls: ['./mdbg_focus_dataflow_panel.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MdbgFocusDataflowPanelComponent {
  @Input({required: true}) modelGraph!: ModelGraph;
  @Input({required: true}) paneId!: string;
  @ViewChildren('chipElement')
  chipElements!: QueryList<ElementRef<HTMLElement>>;

  readonly nodesSsas = new FormControl<string>('', {nonNullable: true});
  readonly context = new FormControl<string>('both', {nonNullable: true});
  readonly contextDepth = new FormControl<string>('all', {nonNullable: true});

  readonly chipList: string[] = [];
  readonly addedChips = new Set<string>();
  importWarnings: SsaFileImportUnresolvedLine[] = [];

  private readonly changeDetectorRef = inject(ChangeDetectorRef);

  handleClickFocus() {
    if (!this.canFocus) {
      return;
    }

    const params = new URLSearchParams();
    params.set('graph_path', this.graphPath);
    for (const seed of this.nodeSsas) {
      params.append('seed', seed);
    }
    const focusRouteOptions = this.getFocusRouteOptions();
    params.set('mode', focusRouteOptions.mode);
    params.set('context', focusRouteOptions.context);
    params.set('context_depth', this.contextDepth.value.trim());

    const nodeDataPaths = this.getNodeDataPathsFromUrl();
    if (nodeDataPaths.length > 0) {
      params.set('node_data_paths', nodeDataPaths.join(','));
    }

    window.open(`/focus?${params.toString()}`, '_blank', 'noopener');
  }

  private getFocusRouteOptions(): {mode: string; context: string} {
    const context = this.context.value;
    if (context === 'inter-seed') {
      return {mode: 'inter-seed', context: 'none'};
    }

    return {
      mode: this.nodeSsas.length === 1 ? 'single' : 'union',
      context,
    };
  }

  appendToken(token: string): void {
    const normalizedToken = token.trim();
    if (normalizedToken === '') {
      return;
    }
    if (this.chipList.includes(normalizedToken)) {
      this.addedChips.delete(normalizedToken);
      this.changeDetectorRef.markForCheck();
      return;
    }

    this.chipList.push(normalizedToken);
    this.syncNodesSsas();
    this.addedChips.add(normalizedToken);
    this.changeDetectorRef.markForCheck();

    setTimeout(() => {
      this.scrollChipIntoView(normalizedToken);
    });
    setTimeout(() => {
      this.addedChips.delete(normalizedToken);
      this.changeDetectorRef.markForCheck();
    }, 400);
  }

  removeToken(token: string): void {
    const index = this.chipList.indexOf(token);
    if (index === -1) {
      return;
    }

    this.chipList.splice(index, 1);
    this.addedChips.delete(token);
    this.syncNodesSsas();
    this.changeDetectorRef.markForCheck();
  }

  clearTokens(): void {
    this.chipList.length = 0;
    this.addedChips.clear();
    this.syncNodesSsas();
    this.changeDetectorRef.markForCheck();
  }

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) {
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const fileText = String(reader.result ?? '');
      const outputNodeSsas = this.getOutputNodeSsas();
      const result = importFromLines(fileText.split(/\r?\n/), outputNodeSsas);

      this.clearTokens();
      for (const ssa of result.resolved) {
        this.appendToken(ssa);
      }

      this.importWarnings = result.unresolved;
      input.value = '';
      this.changeDetectorRef.markForCheck();
      this.handleClickFocus();
    };
    reader.onerror = () => {
      this.importWarnings = [
        {line: file.name, reason: 'unable to read file'},
      ];
      input.value = '';
      this.changeDetectorRef.markForCheck();
    };
    reader.readAsText(file);
  }

  get graphPath(): string {
    return this.modelGraph?.modelPath ?? '';
  }

  get nodeSsas(): string[] {
    return [...this.chipList];
  }

  get canFocus(): boolean {
    return this.graphPath !== '' && this.nodeSsas.length > 0;
  }

  private syncNodesSsas(): void {
    this.nodesSsas.setValue(this.chipList.join('\n'));
  }

  private scrollChipIntoView(token: string): void {
    const chip = this.chipElements?.find(
      (elementRef) => elementRef.nativeElement.dataset['token'] === token,
    );
    chip?.nativeElement.scrollIntoView({
      behavior: 'smooth',
      block: 'nearest',
    });
  }

  private getNodeDataPathsFromUrl(): string[] {
    const data = new URLSearchParams(window.location.search).get('data');
    if (!data) {
      return [];
    }

    try {
      const parsed = JSON.parse(data) as {nodeData?: unknown};
      if (!Array.isArray(parsed.nodeData)) {
        return [];
      }
      return parsed.nodeData.filter((item): item is string => {
        return typeof item === 'string' && item.length > 0;
      });
    } catch {
      return [];
    }
  }

  private getOutputNodeSsas(): string[] {
    const outputNodes =
      this.modelGraph?.nodes?.filter((node) => isOutputsNode(node)) ?? [];
    const mdbgOutputs = outputNodes
      .filter((node) => readAttr(node, 'mdbg_kind') === 'function_output')
      .sort((a, b) => {
        return (
          Number(readAttr(a, 'mdbg_output_index') ?? '0') -
          Number(readAttr(b, 'mdbg_output_index') ?? '0')
        );
      })
      .map((node) => readAttr(node, SSA_ATTR_KEY) ?? '');

    if (mdbgOutputs.length > 0) {
      return mdbgOutputs;
    }

    const graphOutputsNode = outputNodes.find((node) => isOpNode(node));
    if (!graphOutputsNode || !isOpNode(graphOutputsNode)) {
      console.warn(
        'Outputs node not found; output aliases cannot resolve.',
      );
      return [];
    }

    return [...(graphOutputsNode.incomingEdges || [])]
      .sort((a, b) => {
        return Number(a.targetNodeInputId) - Number(b.targetNodeInputId);
      })
      .map((edge) => {
        const sourceNode = this.modelGraph.nodesById?.[edge.sourceNodeId];
        if (!sourceNode || !isOpNode(sourceNode)) {
          return '';
        }
        const sourceSsa = sourceNode.attrs?.[SSA_ATTR_KEY];
        if (typeof sourceSsa === 'string' && sourceSsa !== '') {
          return sourceSsa;
        }
        const outputSsa =
          sourceNode.outputsMetadata?.[edge.sourceNodeOutputId]?.[SSA_ATTR_KEY];
        return typeof outputSsa === 'string' ? outputSsa : '';
      });
  }
}
