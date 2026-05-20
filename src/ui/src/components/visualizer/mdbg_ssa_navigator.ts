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
  inject,
  Input,
  OnChanges,
  OnInit,
  SimpleChanges,
} from '@angular/core';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {FormControl, ReactiveFormsModule} from '@angular/forms';
import {MatButtonModule} from '@angular/material/button';
import {MatIconModule} from '@angular/material/icon';

import {AppService} from './app_service';
import {LocateNodeInfo} from './common/types';
import {ModelGraph, OpNode} from './common/model_graph';
import {isOpNode} from './common/utils';

interface SsaRow {
  node: OpNode;
  opName: string;
  ssa: string;
}

const SSA_ATTR_KEY = 'mdbg_source_ssa';

/** Right-sidebar navigator for jumping to nodes by source SSA value. */
@Component({
  standalone: true,
  selector: 'mdbg-ssa-navigator',
  imports: [
    CommonModule,
    MatButtonModule,
    MatIconModule,
    ReactiveFormsModule,
  ],
  templateUrl: './mdbg_ssa_navigator.ng.html',
  styleUrls: ['./mdbg_ssa_navigator.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MdbgSsaNavigatorComponent implements OnInit, OnChanges {
  @Input({required: true}) modelGraph!: ModelGraph;
  @Input({required: true}) paneId!: string;

  readonly filterControl = new FormControl('', {nonNullable: true});

  collapsed = false;
  rows: SsaRow[] = [];
  filteredRows: SsaRow[] = [];

  private readonly appService = inject(AppService);
  private readonly changeDetectorRef = inject(ChangeDetectorRef);
  private readonly destroyRef = inject(DestroyRef);

  ngOnInit() {
    this.rebuildRows();
    this.filterControl.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.applyFilter();
        this.changeDetectorRef.markForCheck();
      });
  }

  ngOnChanges(changes: SimpleChanges) {
    if (changes['modelGraph']) {
      this.rebuildRows();
    }
  }

  handleToggle() {
    this.collapsed = !this.collapsed;
  }

  handleClearFilter() {
    this.filterControl.setValue('');
  }

  handleClickRow(row: SsaRow) {
    const info: LocateNodeInfo = {
      nodeId: row.node.id,
      rendererId: this.paneId,
      isGroupNode: false,
    };
    this.appService.curToLocateNodeInfo.set(info);
  }

  trackByNodeId(index: number, row: SsaRow): string {
    return row.node.id;
  }

  get toggleIcon(): string {
    return this.collapsed ? 'chevron_right' : 'expand_more';
  }

  private rebuildRows() {
    const rows: SsaRow[] = [];
    for (const node of this.modelGraph?.nodes || []) {
      if (!isOpNode(node)) {
        continue;
      }
      const ssaValue = node.attrs?.[SSA_ATTR_KEY];
      rows.push({
        node,
        opName: node.label,
        ssa: typeof ssaValue === 'string' ? ssaValue : '',
      });
    }
    this.rows = rows;
    this.applyFilter();
    this.changeDetectorRef.markForCheck();
  }

  private applyFilter() {
    const filterText = this.filterControl.value.trim().toLowerCase();
    if (!filterText) {
      this.filteredRows = this.rows;
      return;
    }
    this.filteredRows = this.rows.filter((row) => {
      return (
        row.opName.toLowerCase().includes(filterText) ||
        row.ssa.toLowerCase().includes(filterText)
      );
    });
  }
}
