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
import {MatButtonModule} from '@angular/material/button';
import {setAnchorHref} from 'safevalues/dom';

import {ModelGraph} from './common/model_graph';
import {getOutputNodeSsas} from './mdbg_graph_attrs';
import {buildMlirExport} from './mdbg_mlir_exporter';
import {MdbgSsaChipBoxComponent} from './mdbg_ssa_chip_box';

/** Toolbar panel for copying/downloading selected nodes as raw MLIR. */
@Component({
  standalone: true,
  selector: 'mdbg-export-mlir-panel',
  imports: [CommonModule, MatButtonModule, MdbgSsaChipBoxComponent],
  templateUrl: './mdbg_export_mlir_panel.ng.html',
  styleUrls: ['./mdbg_export_mlir_panel.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MdbgExportMlirPanelComponent {
  @Input({required: true}) modelGraph!: ModelGraph;
  @Input({required: true}) paneId!: string;
  @ViewChild(MdbgSsaChipBoxComponent)
  opChipBox?: MdbgSsaChipBoxComponent;

  appendToken(token: string, label?: string): void {
    this.opChipBox?.appendToken(token, label);
  }

  handleClickClear(): void {
    this.opChipBox?.handleClearTokens();
  }

  handleClickCopy(): void {
    const text = this.stitchedMlir;
    if (text === '') {
      return;
    }
    void navigator.clipboard?.writeText(text);
  }

  handleClickExport(): void {
    const text = this.stitchedMlir;
    if (text === '') {
      return;
    }

    const link = document.createElement('a');
    link.download = this.exportFileName;
    setAnchorHref(
      link,
      `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`,
    );
    link.click();
  }

  get outputNodeSsas(): string[] {
    return getOutputNodeSsas(this.modelGraph);
  }

  get opSsas(): string[] {
    return this.opChipBox?.tokens ?? [];
  }

  get stitchedMlir(): string {
    return buildMlirExport(this.modelGraph, this.opSsas);
  }

  get canExport(): boolean {
    return this.stitchedMlir !== '';
  }

  private get exportFileName(): string {
    const modelPath = this.modelGraph?.modelPath ?? '';
    const modelName = modelPath.split(/[\\/]/).pop() || 'mdbg_export';
    const baseName = modelName.replace(/\.[^.]+$/, '') || 'mdbg_export';
    return `${baseName}.mlir`;
  }
}
