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
  Component,
  Input,
  ViewChild,
} from '@angular/core';
import {FormControl, ReactiveFormsModule} from '@angular/forms';
import {MatButtonModule} from '@angular/material/button';

import {
  getOutputNodeSsas,
} from './mdbg_graph_attrs';
import {
  MdbgSsaChipBoxComponent,
  SsaChip,
} from './mdbg_ssa_chip_box';
import {
  SsaFileImportUnresolvedLine,
} from './ssa_file_importer';
import {ModelGraph} from './common/model_graph';

/** Toolbar panel for focusing dataflow from source SSA values. */
@Component({
  standalone: true,
  selector: 'mdbg-focus-dataflow-panel',
  imports: [
    CommonModule,
    MatButtonModule,
    MdbgSsaChipBoxComponent,
    ReactiveFormsModule,
  ],
  templateUrl: './mdbg_focus_dataflow_panel.ng.html',
  styleUrls: ['./mdbg_focus_dataflow_panel.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MdbgFocusDataflowPanelComponent {
  @Input({required: true}) modelGraph!: ModelGraph;
  @Input({required: true}) paneId!: string;
  @ViewChild(MdbgSsaChipBoxComponent)
  seedChipBox?: MdbgSsaChipBoxComponent;

  readonly nodesSsas = new FormControl<string>('', {nonNullable: true});
  readonly context = new FormControl<string>('both', {nonNullable: true});
  readonly contextDepth = new FormControl<string>('all', {nonNullable: true});

  private readonly fallbackSeedInputControl = new FormControl<string>('', {
    nonNullable: true,
  });
  private fallbackImportWarnings: SsaFileImportUnresolvedLine[] = [];

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

  appendToken(token: string, label?: string): void {
    this.seedChipBox?.appendToken(token, label);
  }

  removeToken(token: string): void {
    this.seedChipBox?.removeToken(token);
  }

  clearTokens(): void {
    this.seedChipBox?.clearTokens();
  }

  handleClearSeeds(): void {
    this.seedChipBox?.handleClearTokens();
  }

  commitSeedInput(): void {
    this.syncSeedChipBoxInputs();
    this.seedChipBox?.commitTokenInput();
  }

  onSeedInputBackspace(): void {
    this.seedChipBox?.onTokenInputBackspace();
  }

  getNextOutputSeedLabel(nodeLabel: string): string {
    const existingChipCount = this.chipList.filter((chip) =>
      chip.label.startsWith(`${nodeLabel} #`),
    ).length;
    return `${nodeLabel} #${existingChipCount + 1}`;
  }

  onFileSelected(event: Event): void {
    this.syncSeedChipBoxInputs();
    this.seedChipBox?.onFileSelected(event);
  }

  get graphPath(): string {
    return this.modelGraph?.modelPath ?? '';
  }

  get nodeSsas(): string[] {
    return this.seedChipBox?.tokens ?? [];
  }

  get canFocus(): boolean {
    return this.graphPath !== '' && this.nodeSsas.length > 0;
  }

  get chipList(): SsaChip[] {
    return this.seedChipBox?.chipList ?? [];
  }

  get addedChips(): Set<string> {
    return this.seedChipBox?.addedChips ?? new Set<string>();
  }

  get seedInputControl(): FormControl<string> {
    return this.seedChipBox?.tokenInputControl ?? this.fallbackSeedInputControl;
  }

  get importWarnings(): SsaFileImportUnresolvedLine[] {
    return this.seedChipBox?.importWarnings ?? this.fallbackImportWarnings;
  }

  set importWarnings(value: SsaFileImportUnresolvedLine[]) {
    if (this.seedChipBox) {
      this.seedChipBox.importWarnings = value;
    } else {
      this.fallbackImportWarnings = value;
    }
  }

  get outputNodeSsas(): string[] {
    return this.getOutputNodeSsas();
  }

  handleImportedSeeds(): void {
    this.handleClickFocus();
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
    return getOutputNodeSsas(this.modelGraph);
  }

  private syncSeedChipBoxInputs(): void {
    if (this.seedChipBox) {
      this.seedChipBox.outputNodeSsas = this.outputNodeSsas;
    }
  }
}
