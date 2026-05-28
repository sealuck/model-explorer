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

import {TestBed} from '@angular/core/testing';

import {AppService} from './app_service';
import {ModelGraph, NodeType} from './common/model_graph';
import {RendererWrapper} from './renderer_wrapper';
import {SubgraphSelectionService} from './subgraph_selection_service';

describe('RendererWrapper', () => {
  let appService: jasmine.SpyObj<AppService>;
  let subgraphSelectionService: jasmine.SpyObj<SubgraphSelectionService>;

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
    subgraphSelectionService =
      jasmine.createSpyObj<SubgraphSelectionService>(
        'SubgraphSelectionService',
        ['clearSelection'],
      );

    TestBed.configureTestingModule({
      imports: [RendererWrapper],
      providers: [
        {provide: AppService, useValue: appService},
        {provide: SubgraphSelectionService, useValue: subgraphSelectionService},
      ],
    });
    TestBed.overrideComponent(RendererWrapper, {
      set: {template: ''},
    });
  });

  it('should_complete_focus_when_switching_from_multi_to_single', () => {
    const fixture = TestBed.createComponent(RendererWrapper);
    const component = fixture.componentInstance;
    let clearedBeforeOpen = false;
    subgraphSelectionService.clearSelection.and.callFake(() => {
      clearedBeforeOpen = true;
    });
    const openSpy = spyOn(window, 'open').and.callFake(() => {
      expect(clearedBeforeOpen).toBeTrue();
      return null;
    });
    const clearTokens = jasmine.createSpy('clearTokens');

    component.paneId = 'pane-id';
    component.rendererId = 'renderer-id';
    component.modelGraph = {
      id: 'graph-id',
      collectionLabel: 'collection',
      modelPath: '/tmp/model.mlir',
      nodes: [],
      nodesById: {
        'single-node': {
          id: 'single-node',
          label: 'single node',
          namespace: '',
          level: 0,
          nodeType: NodeType.OP_NODE,
          attrs: {'mdbg_source_ssa': '%0'},
        },
      },
      rootNodes: [],
      edgesByGroupNodeIds: {},
      layoutGraphEdges: {},
      maxDescendantOpNodeCount: 0,
      minDescendantOpNodeCount: 0,
    } as ModelGraph;
    component.showMultiFocusDialog = true;
    component.multiFocusDialogRef = {clearTokens} as any;

    component.handleClickFocusDataflow();

    expect(subgraphSelectionService.clearSelection).toHaveBeenCalled();
    expect(clearTokens).toHaveBeenCalled();
    expect(component.showMultiFocusDialog).toBeFalse();
    expect(openSpy).toHaveBeenCalledWith(
      '/focus?graph_path=%2Ftmp%2Fmodel.mlir&node_ssa=%250&direction=both&depth=-1',
      '_blank',
      'noopener',
    );
  });
});
