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

import {signal} from '@angular/core';
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {NoopAnimationsModule} from '@angular/platform-browser/animations';
import {Subject} from 'rxjs';

import {AppService} from './app_service';
import {ModelGraph, NodeType, OpNode} from './common/model_graph';
import {NodeDataProviderExtensionService} from './node_data_provider_extension_service';
import {SplitPaneService} from './split_pane_service';
import {InfoPanel} from './info_panel';
import {
  ColorVariable,
  VisualizerThemeService,
} from './visualizer_theme_service';

describe('InfoPanel', () => {
  let fixture: ComponentFixture<InfoPanel>;
  let pane: {modelGraph: ModelGraph; selectedNodeInfo: {nodeId: string}};

  beforeEach(async () => {
    pane = {
      modelGraph: createModelGraph(createOpNode({})),
      selectedNodeInfo: {nodeId: 'node_1'},
    };

    await TestBed.configureTestingModule({
      imports: [InfoPanel, NoopAnimationsModule],
      providers: [
        {
          provide: AppService,
          useValue: {
            command: new Subject(),
            config: signal(undefined),
            curToLocateNodeInfo: signal(undefined),
            getPaneById: () => pane,
            getPaneIndexById: () => 0,
            testMode: true,
            theme: signal('light'),
          },
        },
        {
          provide: NodeDataProviderExtensionService,
          useValue: {
            getRunsForModelGraph: () => [],
            runs: signal({}),
          },
        },
        {
          provide: SplitPaneService,
          useValue: {
            resetInputOutputHiddenIds: () => {},
          },
        },
        {
          provide: VisualizerThemeService,
          useValue: {
            getColor: (variable: ColorVariable) => variable,
          },
        },
      ],
    }).compileComponents();
  });

  afterEach(() => {
    fixture?.destroy();
  });

  it('should_show_body_section_when_node_has_body_attr', () => {
    const body = '%0 = arith.constant 0 : index\nlinalg.yield %0 : index';
    pane.modelGraph = createModelGraph(createOpNode({body}));
    fixture = createComponent();

    const textContent = getTextContent();
    expect(textContent).toContain('Body');
    expect(textContent).toContain(body);
  });

  it('should_not_show_body_section_when_node_has_no_body_attr', () => {
    pane.modelGraph = createModelGraph(createOpNode({iterator_types: '[]'}));
    fixture = createComponent();

    expect(getTextContent()).not.toContain('Body');
  });

  // Body must render only in its dedicated section, not also as a raw attribute.
  it('should_not_duplicate_body_in_attributes_section_when_node_has_body_attr', () => {
    const body = '%0 = arith.constant 0 : index\nlinalg.yield %0 : index';
    pane.modelGraph = createModelGraph(createOpNode({body}));
    fixture = createComponent();

    expect(countOccurrences(getTextContent(), body)).toBe(1);
  });

  it('should_show_constants_section_when_node_has_mdbg_constants_attr', () => {
    const constants = 'input 1: %c10 = arith.constant 10 : index';
    pane.modelGraph = createModelGraph(createOpNode({mdbg_constants: constants}));
    fixture = createComponent();

    const textContent = getTextContent();
    expect(textContent).toContain('Constants');
    expect(textContent).toContain(constants);
    // Rendered in its own section only, not also as a raw attribute.
    expect(countOccurrences(textContent, constants)).toBe(1);
  });

  it('should_not_show_constants_section_when_node_has_no_mdbg_constants_attr', () => {
    pane.modelGraph = createModelGraph(createOpNode({iterator_types: '[]'}));
    fixture = createComponent();

    expect(getTextContent()).not.toContain('Constants');
  });

  function createComponent(): ComponentFixture<InfoPanel> {
    const fixture = TestBed.createComponent(InfoPanel);
    fixture.componentInstance.paneId = 'pane_1';
    fixture.detectChanges();
    return fixture;
  }

  function getTextContent(): string {
    return fixture.nativeElement.textContent;
  }
});

function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') {
    return 0;
  }
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function createOpNode(attrs: Record<string, string>): OpNode {
  return {
    attrs,
    id: 'node_1',
    label: 'linalg.generic',
    level: 0,
    namespace: '',
    nodeType: NodeType.OP_NODE,
  };
}

function createModelGraph(node: OpNode): ModelGraph {
  return {
    collectionLabel: 'collection',
    edgesByGroupNodeIds: {},
    id: 'graph',
    layoutGraphEdges: {},
    maxDescendantOpNodeCount: 0,
    minDescendantOpNodeCount: 0,
    nodes: [node],
    nodesById: {[node.id]: node},
    rootNodes: [node],
  };
}
