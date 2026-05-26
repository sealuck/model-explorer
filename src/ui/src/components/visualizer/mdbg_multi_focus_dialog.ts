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
  OnInit,
} from '@angular/core';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {FormControl, ReactiveFormsModule} from '@angular/forms';
import {MatButtonModule} from '@angular/material/button';
import {MatIconModule} from '@angular/material/icon';

import {ModelGraph} from './common/model_graph';

/** Toolbar dialog for focusing dataflow from multiple source SSA values. */
@Component({
  standalone: true,
  selector: 'mdbg-multi-focus-dialog',
  imports: [
    CommonModule,
    MatButtonModule,
    MatIconModule,
    ReactiveFormsModule,
  ],
  templateUrl: './mdbg_multi_focus_dialog.ng.html',
  styleUrls: ['./mdbg_multi_focus_dialog.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MdbgMultiFocusDialogComponent implements OnInit {
  @Input({required: true}) modelGraph!: ModelGraph;
  @Input({required: true}) paneId!: string;

  readonly nodesSsas = new FormControl<string>('', {nonNullable: true});
  readonly mode = new FormControl<string>('union', {nonNullable: true});
  readonly direction = new FormControl<string>('both', {nonNullable: true});
  readonly depth = new FormControl<string>('all', {nonNullable: true});

  private readonly changeDetectorRef = inject(ChangeDetectorRef);
  private readonly destroyRef = inject(DestroyRef);

  ngOnInit() {
    this.mode.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((mode) => {
        if (mode === 'inter-seed') {
          this.direction.disable();
        } else {
          this.direction.enable();
        }
        this.changeDetectorRef.markForCheck();
      });
  }

  handleClickFocus() {
    if (!this.canFocus) {
      return;
    }

    const params = new URLSearchParams();
    params.set('graph_path', this.graphPath);
    params.set('node_ssas', this.nodeSsas.join(','));
    params.set('mode', this.mode.value);
    params.set('depth', this.depth.value.trim());
    if (this.mode.value !== 'inter-seed') {
      params.set('direction', this.direction.value);
    }

    window.open(`/multi-focus?${params.toString()}`, '_blank', 'noopener');
  }

  get graphPath(): string {
    return this.modelGraph?.modelPath ?? '';
  }

  get nodeSsas(): string[] {
    return this.nodesSsas.value
      .split(/[,\n]/)
      .map((token) => token.trim())
      .filter((token) => token.length > 0);
  }

  get showDirection(): boolean {
    return this.mode.value !== 'inter-seed';
  }

  get canFocus(): boolean {
    return this.graphPath !== '' && this.nodeSsas.length > 0;
  }
}
