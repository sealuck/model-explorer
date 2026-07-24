/**
 * @license
 * Copyright 2026 The Model Explorer Authors. All Rights Reserved.
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

import {Graph} from '../common/input_graph';
import {GroupNode, OpNode} from '../common/model_graph';
import {GraphProcessor} from './graph_processor';

describe('GraphProcessor layout-only edges', () => {
  it('orders resultless producers without creating tensor ports', () => {
    const graph: Graph = {
      id: 'main',
      nodes: [
        {id: 'writer', label: 'memref.store', namespace: ''},
        {id: 'reader', label: 'memref.load', namespace: ''},
      ],
      layoutEdges: [
        {
          id: 'content',
          sourceNodeId: 'writer',
          targetNodeId: 'reader',
        },
      ],
    };

    const modelGraph = new GraphProcessor('pane', graph).process();
    const writer = modelGraph.nodesById['writer'] as OpNode;
    const reader = modelGraph.nodesById['reader'] as OpNode;

    expect(writer.outgoingEdges).toBeUndefined();
    expect(reader.incomingEdges).toBeUndefined();
    expect(modelGraph.layoutGraphEdges['']['writer']['reader']).toBeTrue();
  });

  it('summarizes storage presentation on a collapsed namespace', () => {
    const graph: Graph = {
      id: 'main',
      nodes: [
        {
          id: 'first',
          label: 'first',
          namespace: 'layer',
          style: {accentColors: ['#4477AA'], tintColor: '#4477AA'},
        },
        {
          id: 'second',
          label: 'second',
          namespace: 'layer',
          style: {
            accentColors: ['#4477AA', '#EE6677'],
            tintColor: '#4477AA',
          },
        },
      ],
    };

    const modelGraph = new GraphProcessor('pane', graph).process();
    const layer = modelGraph.nodesById['layer___group___'] as GroupNode;

    expect(layer.style?.accentColors).toEqual(['#4477AA', '#EE6677']);
    expect(layer.style?.tintColor).toBe('#4477AA');
  });
});
