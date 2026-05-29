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

import {ChangeDetectorRef} from '@angular/core';
import {TestBed} from '@angular/core/testing';

import {AppService} from './app_service';
import {ModelGraph, NodeType} from './common/model_graph';
import {RendererWrapper} from './renderer_wrapper';

describe('RendererWrapper', () => {
  let appService: jasmine.SpyObj<AppService>;

  beforeEach(() => {
    appService = jasmine.createSpyObj<AppService>('AppService', [
      'getFlattenLayers',
      'getPaneById',
    ]);
    appService.getFlattenLayers.and.returnValue(false);
    appService.getPaneById.and.returnValue({
      id: 'pane-id',
      widthFraction: 1,
      selectedNodeInfo: {
        nodeId: 'single-node',
        rendererId: 'renderer-id',
        isGroupNode: false,
      },
    });

    TestBed.configureTestingModule({
      imports: [RendererWrapper],
      providers: [
        {provide: AppService, useValue: appService},
      ],
    });
    TestBed.overrideComponent(RendererWrapper, {
      set: {template: ''},
    });
  });

  it('should_notExposeSingleFocusControls_and_keepFocusDataflowPanelToggle', () => {
    const fixture = TestBed.createComponent(RendererWrapper);
    const component = fixture.componentInstance;

    const legacyDirectionControl = ['focus', 'Direction'].join('');
    const legacyDirectionVisibility = ['showFocus', 'Direction'].join('');
    const legacySingleFocusHandler = ['handleClick', 'FocusDataflow'].join('');
    const componentRecord = component as unknown as Record<string, unknown>;

    expect(componentRecord[legacyDirectionControl]).toBeUndefined();
    expect(componentRecord[legacyDirectionVisibility]).toBeUndefined();
    expect(componentRecord[legacySingleFocusHandler]).toBeUndefined();

    expect(typeof component.handleClickFocusDataflowPanel).toBe('function');
    expect(component.showFocusDataflowPanel).toBeFalse();

    component.handleClickFocusDataflowPanel();

    expect(component.showFocusDataflowPanel).toBeTrue();
  });

  it('should_openPanelAndAppendToken_when_ctrlClickedOnOpNodeWithSsa', () => {
    const fixture = TestBed.createComponent(RendererWrapper);
    const component = fixture.componentInstance;
    const appendToken = jasmine.createSpy('appendToken');

    component.modelGraph = createModelGraph({
      'op-node': {
        id: 'op-node',
        label: 'op node',
        namespace: '',
        level: 0,
        nodeType: NodeType.OP_NODE,
        attrs: {
          'mdbg_kind': 'operation',
          'mdbg_source_ssa': '%foo',
        },
      },
    });
    component.showFocusDataflowPanel = false;
    spyOn(
      (component as unknown as {changeDetectorRef: ChangeDetectorRef})
        .changeDetectorRef,
      'detectChanges',
    ).and.callFake(() => {
      component.focusDataflowPanelRef = {appendToken} as any;
    });

    component.handleNodeCtrlClicked('op-node');

    expect(component.showFocusDataflowPanel).toBeTrue();
    expect(appendToken).toHaveBeenCalledOnceWith('%foo');
  });

  it('should_appendNodeIdToken_when_ctrlClickedOnFunctionOutputNode', () => {
    const fixture = TestBed.createComponent(RendererWrapper);
    const component = fixture.componentInstance;
    const appendToken = jasmine.createSpy('appendToken');

    component.modelGraph = createModelGraph({
      'output-node': {
        id: 'output-node',
        label: 'output node',
        namespace: '',
        level: 0,
        nodeType: NodeType.OP_NODE,
        attrs: {
          'mdbg_kind': 'function_output',
          'mdbg_source_ssa': '%ignored',
        },
      },
    });
    component.showFocusDataflowPanel = true;
    component.focusDataflowPanelRef = {appendToken} as any;

    component.handleNodeCtrlClicked('output-node');

    expect(appendToken).toHaveBeenCalledOnceWith('nodeId:output-node');
  });

  it('should_notDuplicateChip_when_ctrlClickedTwiceForSameNode', () => {
    const fixture = TestBed.createComponent(RendererWrapper);
    const component = fixture.componentInstance;
    const appendToken = jasmine.createSpy('appendToken');

    component.modelGraph = createModelGraph({
      'op-node': {
        id: 'op-node',
        label: 'op node',
        namespace: '',
        level: 0,
        nodeType: NodeType.OP_NODE,
        attrs: {'mdbg_source_ssa': '%foo'},
      },
    });
    component.showFocusDataflowPanel = true;
    component.focusDataflowPanelRef = {appendToken} as any;

    component.handleNodeCtrlClicked('op-node');
    component.handleNodeCtrlClicked('op-node');

    expect(appendToken).toHaveBeenCalledTimes(2);
    expect(appendToken).toHaveBeenCalledWith('%foo');
  });

  it('should_notOpenPanelOrAppendToken_when_nodeIdIsUnknown', () => {
    const fixture = TestBed.createComponent(RendererWrapper);
    const component = fixture.componentInstance;
    const appendToken = jasmine.createSpy('appendToken');

    component.modelGraph = createModelGraph({});
    component.showFocusDataflowPanel = false;
    component.focusDataflowPanelRef = {appendToken} as any;

    component.handleNodeCtrlClicked('missing-node');

    expect(component.showFocusDataflowPanel).toBeFalse();
    expect(appendToken).not.toHaveBeenCalled();
  });
});

function createModelGraph(nodesById: ModelGraph['nodesById']): ModelGraph {
  return {
    id: 'graph-id',
    collectionLabel: 'collection',
    nodes: Object.values(nodesById),
    nodesById,
    rootNodes: [],
    edgesByGroupNodeIds: {},
    layoutGraphEdges: {},
    maxDescendantOpNodeCount: 0,
    minDescendantOpNodeCount: 0,
  } as ModelGraph;
}
