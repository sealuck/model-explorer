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
import {MdbgFocusDataflowPanelComponent} from './mdbg_focus_dataflow_panel';

describe('MdbgFocusDataflowPanelComponent', () => {
  let fixture: ComponentFixture<MdbgFocusDataflowPanelComponent>;
  let component: MdbgFocusDataflowPanelComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [MdbgFocusDataflowPanelComponent],
      providers: [provideNoopAnimations()],
    }).compileComponents();

    fixture = TestBed.createComponent(MdbgFocusDataflowPanelComponent);
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
    expect(component.chipList).toEqual([
      {token: '%1', label: '%1'},
      {token: '%2', label: '%2'},
    ]);
  });

  it('should_clear_all_seeds_when_clear_button_clicked', () => {
    component.appendToken('%0');
    component.appendToken('%1');
    fixture.detectChanges();

    component.handleClearSeeds();
    fixture.detectChanges();

    expect(component.chipList).toEqual([]);
    expect(component.nodeSsas).toEqual([]);
  });

  it('should_disable_clear_button_when_no_seeds', () => {
    let clearSeedsButton = fixture.nativeElement.querySelector(
      '.clear-seeds-button',
    ) as HTMLButtonElement;

    expect(clearSeedsButton.disabled).toBeTrue();

    component.appendToken('%0');
    fixture.detectChanges();
    clearSeedsButton = fixture.nativeElement.querySelector(
      '.clear-seeds-button',
    ) as HTMLButtonElement;

    expect(clearSeedsButton.disabled).toBeFalse();
  });

  it('should_clear_import_warnings_when_seeds_cleared', () => {
    component.importWarnings = [{line: 'x', reason: 'y'}];
    component.appendToken('%0');
    fixture.detectChanges();

    component.handleClearSeeds();
    fixture.detectChanges();

    expect(component.importWarnings).toEqual([]);
  });

  it('should_render_output_seed_chip_label_instead_of_token', () => {
    const token = 'nodeId:foo.mlir:1:1::outputs3';

    component.appendToken(token, 'outputs3');
    fixture.detectChanges();

    expect(getChipLabelText()).toBe('outputs3');
    expect(component.chipList).toEqual([{token, label: 'outputs3'}]);
    expect(getChipElement().getAttribute('title')).toBe(token);
  });

  it('should_build_focus_url_with_output_seed_token', () => {
    const openSpy = spyOn(window, 'open');
    component.appendToken('nodeId:foo.mlir:1:1::outputs3', 'outputs3');

    component.handleClickFocus();

    const params = getFocusUrlParams(
      openSpy.calls.mostRecent().args[0] as string,
    );
    expect(params.getAll('seed')).toEqual(['nodeId:foo.mlir:1:1::outputs3']);
  });

  it('should_keep_trailing_segment_output_seed_labels', () => {
    component.appendToken('nodeId:foo.mlir:1:1::outputs0', 'outputs0');
    component.appendToken('nodeId:foo.mlir:1:1::outputs1', 'outputs1');

    expect(component.chipList.map((chip) => chip.label)).toEqual([
      'outputs0',
      'outputs1',
    ]);
  });

  it('should_deduplicate_output_seed_chips_by_token', () => {
    component.appendToken('nodeId:foo.mlir:1:1::outputs3', 'outputs3');
    component.appendToken('nodeId:foo.mlir:1:1::outputs3', 'outputs4');

    expect(component.chipList).toEqual([
      {token: 'nodeId:foo.mlir:1:1::outputs3', label: 'outputs3'},
    ]);
  });

  it('should_expose_full_seed_token_in_chip_title', () => {
    component.appendToken('nodeId:foo.mlir:1:1::outputs3', 'outputs3');
    fixture.detectChanges();

    expect(getChipElement().getAttribute('title')).toBe(
      'nodeId:foo.mlir:1:1::outputs3',
    );
  });

  it('should_render_import_seeds_above_seed_chip_list', () => {
    const importSeeds = fixture.nativeElement.querySelector(
      '.import-seeds-section',
    ) as HTMLElement;
    const seedChipList = fixture.nativeElement.querySelector(
      '.seed-chip-list-section',
    ) as HTMLElement;

    expect(importSeeds.compareDocumentPosition(seedChipList)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('should_render_context_options_with_both_default', () => {
    fixture.detectChanges();

    const options = Array.from(
      fixture.nativeElement.querySelectorAll('select option'),
    ).map((option) => ({
      value: (option as HTMLOptionElement).value,
      text: (option as HTMLOptionElement).textContent?.trim(),
    }));

    expect(options).toEqual([
      {value: 'inter-seed', text: 'Inter-seed'},
      {value: 'upstream', text: 'Upstream'},
      {value: 'downstream', text: 'Downstream'},
      {value: 'both', text: 'Both'},
    ]);
    expect(component.context.value).toBe('both');
  });

  it('should_build_focus_url_for_inter_seed_context', () => {
    const openSpy = spyOn(window, 'open');
    component.appendToken('%0');
    component.appendToken('%1');
    component.context.setValue('inter-seed');
    component.contextDepth.setValue('all');
    window.history.pushState(
      {},
      '',
      `/?data=${encodeURIComponent(
        JSON.stringify({nodeData: ['/tmp/node-data.json']}),
      )}`,
    );

    try {
      component.handleClickFocus();
    } finally {
      window.history.replaceState({}, '', '/');
    }

    expect(openSpy).toHaveBeenCalled();
    const url = openSpy.calls.mostRecent().args[0] as string;
    const params = getFocusUrlParams(url);
    expect(params.get('mode')).toBe('inter-seed');
    expect(params.get('context')).toBe('none');
    expect(params.get('context_depth')).toBe('all');
    expect(params.get('node_data_paths')).toBe('/tmp/node-data.json');
  });

  it('should_build_focus_url_for_both_context_with_two_seeds', () => {
    const openSpy = spyOn(window, 'open');
    component.appendToken('%0');
    component.appendToken('%1');
    component.context.setValue('both');
    component.contextDepth.setValue('3');

    component.handleClickFocus();

    const params = getFocusUrlParams(
      openSpy.calls.mostRecent().args[0] as string,
    );
    expect(params.getAll('seed')).toEqual(['%0', '%1']);
    expect(params.get('mode')).toBe('union');
    expect(params.get('context')).toBe('both');
    expect(params.get('context_depth')).toBe('3');
  });

  it('should_build_focus_url_for_both_context_with_one_seed', () => {
    const openSpy = spyOn(window, 'open');
    component.appendToken('%0');
    component.context.setValue('both');
    component.contextDepth.setValue(' 3 ');

    component.handleClickFocus();

    const params = getFocusUrlParams(
      openSpy.calls.mostRecent().args[0] as string,
    );
    expect(params.getAll('seed')).toEqual(['%0']);
    expect(params.get('mode')).toBe('single');
    expect(params.get('context')).toBe('both');
    expect(params.get('context_depth')).toBe('3');
  });

  function getFocusUrlParams(url: string): URLSearchParams {
    expect(url.startsWith('/focus?')).toBeTrue();
    expect(url).not.toContain(['/multi', 'focus'].join('-'));
    const params = new URLSearchParams(url.substring(url.indexOf('?') + 1));
    expect(params.has(['direc', 'tion'].join(''))).toBeFalse();
    expect(params.has(['dep', 'th'].join(''))).toBeFalse();
    return params;
  }

  function getChipElement(): HTMLElement {
    return fixture.nativeElement.querySelector('.chip') as HTMLElement;
  }

  function getChipLabelText(): string {
    const label = fixture.nativeElement.querySelector(
      '.chip-label',
    ) as HTMLElement;
    return label.textContent?.trim() ?? '';
  }
});
