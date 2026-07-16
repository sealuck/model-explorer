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
  EventEmitter,
  inject,
  Input,
  Output,
  QueryList,
  ViewChildren,
} from '@angular/core';
import {FormControl, ReactiveFormsModule} from '@angular/forms';
import {MatButtonModule} from '@angular/material/button';

import {
  importFromLines,
  SsaFileImportUnresolvedLine,
} from './ssa_file_importer';

export interface SsaChip {
  token: string;
  label: string;
}

/** Reusable Viewer SSA chip box with text and .txt import support. */
@Component({
  standalone: true,
  selector: 'viewer-ssa-chip-box',
  imports: [CommonModule, MatButtonModule, ReactiveFormsModule],
  templateUrl: './viewer_ssa_chip_box.ng.html',
  styleUrls: ['./viewer_ssa_chip_box.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ViewerSsaChipBoxComponent {
  @Input() boxLabel = 'Seeds';
  @Input() importButtonText = 'Import seeds from file';
  @Input() clearButtonText = 'Clear Seeds';
  @Input() showClearButton = true;
  @Input() inputAriaLabel = 'Add seed';
  @Input() inputPlaceholder = 'Type SSA, press Enter';
  @Input() removeAriaLabel = 'Remove seed';
  @Input() outputNodeSsas: string[] = [];
  @Output() readonly fileImported = new EventEmitter<void>();
  @ViewChildren('chipElement')
  chipElements!: QueryList<ElementRef<HTMLElement>>;

  readonly tokenInputControl = new FormControl<string>('', {
    nonNullable: true,
  });
  readonly chipList: SsaChip[] = [];
  readonly addedChips = new Set<string>();
  importWarnings: SsaFileImportUnresolvedLine[] = [];

  private readonly changeDetectorRef = inject(ChangeDetectorRef);

  appendToken(token: string, label?: string): void {
    const normalizedToken = token.trim();
    if (normalizedToken === '') {
      return;
    }
    if (this.chipList.some((chip) => chip.token === normalizedToken)) {
      this.addedChips.delete(normalizedToken);
      this.changeDetectorRef.markForCheck();
      return;
    }

    this.chipList.push({
      token: normalizedToken,
      label: label ?? normalizedToken,
    });
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
    const index = this.chipList.findIndex((chip) => chip.token === token);
    if (index === -1) {
      return;
    }

    this.chipList.splice(index, 1);
    this.addedChips.delete(token);
    this.changeDetectorRef.markForCheck();
  }

  clearTokens(): void {
    this.chipList.length = 0;
    this.addedChips.clear();
    this.changeDetectorRef.markForCheck();
  }

  handleClearTokens(): void {
    this.importWarnings = [];
    this.clearTokens();
    this.changeDetectorRef.markForCheck();
  }

  commitTokenInput(): void {
    const tokenInput = this.tokenInputControl.value.trim();
    if (tokenInput === '') {
      return;
    }

    const result = importFromLines([tokenInput], this.outputNodeSsas);
    for (const ssa of result.resolved) {
      this.appendToken(ssa);
    }

    this.importWarnings = result.unresolved;
    this.tokenInputControl.setValue('');
    this.changeDetectorRef.markForCheck();
  }

  onTokenInputBackspace(): void {
    if (this.tokenInputControl.value !== '' || this.chipList.length === 0) {
      return;
    }

    const lastChip = this.chipList[this.chipList.length - 1];
    this.removeToken(lastChip.token);
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
      const result = importFromLines(
        fileText.split(/\r?\n/),
        this.outputNodeSsas,
      );

      this.clearTokens();
      for (const ssa of result.resolved) {
        this.appendToken(ssa);
      }

      this.importWarnings = result.unresolved;
      input.value = '';
      this.changeDetectorRef.markForCheck();
      this.fileImported.emit();
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

  get tokens(): string[] {
    return this.chipList.map((chip) => chip.token);
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
}
