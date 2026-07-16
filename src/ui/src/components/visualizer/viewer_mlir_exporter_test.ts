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

import {ModelGraph, NodeType, OpNode} from './common/model_graph';
import {
  buildMlirExport,
  resolveMlirExportNodes,
} from './viewer_mlir_exporter';

describe('Viewer MLIR exporter', () => {
  it('sorts selected nodes by viewer.graph_order without repairing skipped defs', () => {
    const graph = createGraph([
      createOp(
        'late',
        '%late',
        '30',
        '%late = arith.subi %middle, %skipped : i32',
      ),
      createOp(
        'skipped',
        '%skipped',
        '10',
        '%skipped = arith.constant 1 : i32',
      ),
      createOp(
        'first',
        '%first',
        '20',
        '%first = arith.addi %arg0, %arg1 : i32',
      ),
      createOp(
        'middle',
        '%middle',
        '25',
        '%middle = arith.muli %first, %arg2 : i32',
      ),
    ]);

    const nodes = resolveMlirExportNodes(graph, ['%middle', '%late', '%first']);
    const mlir = buildMlirExport(graph, ['%middle', '%late', '%first']);

    expect(nodes.map((node) => node.id)).toEqual(['first', 'middle', 'late']);
    expect(mlir).toBe(
      [
        '%first = arith.addi %arg0, %arg1 : i32',
        '%middle = arith.muli %first, %arg2 : i32',
        '%late = arith.subi %middle, %skipped : i32',
      ].join('\n'),
    );
  });

  it('deduplicates referenced constants and emits each before first use', () => {
    const zero = '%c0 = arith.constant 0 : i32';
    const one = '%c1 = arith.constant 1 : i32';
    const graph = createGraph([
      createOp('use-zero', '%a', '1', '%a = arith.addi %arg0, %c0 : i32', {
        'viewer.constants': `input 1: ${zero}`,
      }),
      createOp('use-both', '%b', '2', '%b = arith.addi %a, %c1 : i32', {
        'viewer.constants': [`input 0: ${zero}`, `body: ${one}`].join('\n'),
      }),
      createOp('use-zero-again', '%c', '3', '%c = arith.addi %b, %c0 : i32', {
        'viewer.constants': `body: ${zero}`,
      }),
    ]);

    const mlir = buildMlirExport(graph, ['%c', '%b', '%a']);

    expect(mlir).toBe(
      [
        zero,
        '%a = arith.addi %arg0, %c0 : i32',
        one,
        '%b = arith.addi %a, %c1 : i32',
        '%c = arith.addi %b, %c0 : i32',
      ].join('\n'),
    );
  });
});

function createGraph(nodes: OpNode[]): ModelGraph {
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
  sourceSsa: string,
  order: string,
  opText: string,
  extraAttrs: Record<string, string> = {},
): OpNode {
  return {
    id,
    label: id,
    namespace: '',
    level: 0,
    nodeType: NodeType.OP_NODE,
    attrs: {
      'viewer.source_ssa': sourceSsa,
      'viewer.graph_order': order,
      'viewer.operation_text': opText,
      ...extraAttrs,
    },
  } as OpNode;
}
