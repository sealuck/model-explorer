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
  GroupNode,
  ModelGraph,
  ModelNode,
  NodeType,
  OpNode,
} from './common/model_graph';
import {collectSeedHighlightTargets} from './viewer_seed_highlights';

describe('collectSeedHighlightTargets', () => {
  it('returns rendered seed op nodes', () => {
    const seed = createOp('seed', {'viewer.focus_role': 'seed'});
    const nonSeed = createOp('non-seed', {'viewer.focus_role': 'other'});
    const graph = createGraph([seed, nonSeed]);

    expect(
      collectSeedHighlightTargets(graph, (nodeId) => nodeId === 'seed'),
    ).toEqual(['seed']);
  });

  it('returns the deepest rendered ancestor group for collapsed seeds', () => {
    const root = createGroup('root');
    const inner = createGroup('inner', 'root');
    const seedAttrs = [
      {'key': 'viewer.focus_role', 'value': 'seed'},
    ] as unknown as OpNode['attrs'];
    const seed = createOp(
      'seed',
      seedAttrs,
      'inner',
    );
    const siblingSeed = createOp(
      'sibling-seed',
      {'viewer.focus_role': 'seed'},
      'inner',
    );
    const graph = createGraph([root, inner, seed, siblingSeed]);

    expect(
      collectSeedHighlightTargets(graph, (nodeId) => nodeId === 'root'),
    ).toEqual(['root']);
  });

  it('prefers the closest rendered ancestor group', () => {
    const root = createGroup('root');
    const inner = createGroup('inner', 'root');
    const seed = createOp('seed', {'viewer.focus_role': 'seed'}, 'inner');
    const graph = createGraph([root, inner, seed]);

    expect(
      collectSeedHighlightTargets(graph, (nodeId) =>
        ['root', 'inner'].includes(nodeId),
      ),
    ).toEqual(['inner']);
  });
});

function createGraph(nodes: ModelNode[]): ModelGraph {
  return {
    id: 'graph-id',
    collectionLabel: 'collection',
    nodes,
    nodesById: Object.fromEntries(nodes.map((node) => [node.id, node])),
    rootNodes: [],
    edgesByGroupNodeIds: {},
    layoutGraphEdges: {},
    maxDescendantOpNodeCount: 0,
    minDescendantOpNodeCount: 0,
  } as ModelGraph;
}

function createOp(
  id: string,
  attrs: OpNode['attrs'],
  nsParentId?: string,
): OpNode {
  return {
    id,
    label: id,
    namespace: '',
    level: 0,
    nodeType: NodeType.OP_NODE,
    attrs,
    nsParentId,
  } as OpNode;
}

function createGroup(id: string, nsParentId?: string): GroupNode {
  return {
    id,
    label: id,
    namespace: '',
    level: 0,
    nodeType: NodeType.GROUP_NODE,
    nsParentId,
    expanded: false,
  } as GroupNode;
}
