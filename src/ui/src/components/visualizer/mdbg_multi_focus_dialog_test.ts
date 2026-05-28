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

import {
  ComponentFixture,
  fakeAsync,
  TestBed,
  tick,
} from '@angular/core/testing';
import {provideNoopAnimations} from '@angular/platform-browser/animations';

import {ModelGraph, NodeType, OpNode} from './common/model_graph';
import {MdbgMultiFocusDialogComponent} from './mdbg_multi_focus_dialog';

describe('MdbgMultiFocusDialogComponent', () => {
  let fixture: ComponentFixture<MdbgMultiFocusDialogComponent>;
  let component: MdbgMultiFocusDialogComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [MdbgMultiFocusDialogComponent],
      providers: [provideNoopAnimations()],
    }).compileComponents();

    fixture = TestBed.createComponent(MdbgMultiFocusDialogComponent);
    component = fixture.componentInstance;
    component.modelGraph = {modelPath: '/tmp/model.mlir'} as ModelGraph;
    component.paneId = 'pane-id';
    fixture.detectChanges();
  });

  it('should_show_animation_class_on_new_chip', fakeAsync(() => {
    component.appendToken('%0');
    fixture.detectChanges();
    tick();
    fixture.detectChanges();

    const chip = getChipElement();
    expect(chip.classList.contains('chip-added')).toBeTrue();

    tick(400);
  }));

  it('should_not_show_animation_class_on_duplicate_chip', fakeAsync(() => {
    component.appendToken('%0');
    fixture.detectChanges();
    component.appendToken('%0');
    fixture.detectChanges();
    tick();
    fixture.detectChanges();

    const chip = getChipElement();
    expect(chip.classList.contains('chip-added')).toBeFalse();

    tick(400);
  }));

  it('should_wrap_chips_when_container_is_narrow', () => {
    const container = fixture.nativeElement.querySelector(
      '.chip-container',
    ) as HTMLElement;

    expect(getComputedStyle(container).flexWrap).toBe('wrap');
  });

  it('should_enumerate_mdbg_per_output_nodes_by_output_index', () => {
    const outputNodes = [0, 1, 2].map((index) => {
      return {
        id: `outputs${index}`,
        label: `outputs${index}`,
        namespace: '',
        level: 0,
        nodeType: NodeType.OP_NODE,
        attrs: [
          {key: 'mdbg_kind', value: 'function_output'},
          {key: 'mdbg_output_index', value: String(index)},
          {key: 'mdbg_source_ssa', value: `%val${index}`},
        ],
      } as unknown as OpNode;
    });
    component.modelGraph = {
      nodes: outputNodes,
      nodesById: Object.fromEntries(outputNodes.map((node) => [node.id, node])),
    } as ModelGraph;

    expect(
      (
        component as unknown as {
          getOutputNodeSsas(): string[];
        }
      ).getOutputNodeSsas(),
    ).toEqual(['%val0', '%val1', '%val2']);
  });

  it('should_replace_chip_list_on_file_import', () => {
    const fileReader = {
      result: '%1\n%2',
      onload: null as FileReader['onload'],
      onerror: null as FileReader['onerror'],
      readAsText() {
        this.onload?.call(
          this as unknown as FileReader,
          {} as ProgressEvent<FileReader>,
        );
      },
    };
    spyOn(window, 'FileReader').and.returnValue(
      fileReader as unknown as FileReader,
    );
    spyOn(window, 'open');
    component.appendToken('%0');

    component.onFileSelected({
      target: {
        files: [new File(['%1\n%2'], 'ssas.txt')],
        value: 'ssas.txt',
      },
    } as unknown as Event);

    expect(component.nodeSsas).toEqual(['%1', '%2']);
    expect(component.chipList).toEqual(['%1', '%2']);
  });

  function getChipElement(): HTMLElement {
    return fixture.nativeElement.querySelector('.chip') as HTMLElement;
  }
});
