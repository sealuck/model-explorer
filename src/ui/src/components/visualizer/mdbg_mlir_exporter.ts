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

import {ModelGraph, ModelNode, NodeType, OpNode} from './common/model_graph';
import {readAttr, splitSsaTokens, SSA_ATTR_KEY} from './mdbg_graph_attrs';

const NODE_ID_PREFIX = 'nodeId:';
const MISSING_ORDER = Number.MAX_SAFE_INTEGER;

export function buildMlirExport(
  modelGraph: ModelGraph | undefined,
  selectedTokens: string[],
): string {
  return stitchMlirFromNodes(resolveMlirExportNodes(modelGraph, selectedTokens));
}

export function resolveMlirExportNodes(
  modelGraph: ModelGraph | undefined,
  selectedTokens: string[],
): OpNode[] {
  if (!modelGraph) {
    return [];
  }

  const selectedNodeIds = new Set<string>();
  for (const token of selectedTokens) {
    const normalizedToken = token.trim();
    if (normalizedToken === '') {
      continue;
    }
    for (const node of modelGraph.nodes || []) {
      if (isOpNode(node) && nodeMatchesToken(node, normalizedToken)) {
        selectedNodeIds.add(node.id);
      }
    }
  }

  const originalIndexes = new Map<string, number>();
  modelGraph.nodes.forEach((node, index) => {
    originalIndexes.set(node.id, index);
  });

  return (modelGraph.nodes || [])
    .filter((node): node is OpNode => {
      return isOpNode(node) && selectedNodeIds.has(node.id);
    })
    .sort((a, b) => {
      const orderDiff = readOrder(a) - readOrder(b);
      if (orderDiff !== 0) {
        return orderDiff;
      }
      return (
        (originalIndexes.get(a.id) ?? 0) -
        (originalIndexes.get(b.id) ?? 0)
      );
    });
}

export function stitchMlirFromNodes(nodes: OpNode[]): string {
  const chunks: string[] = [];
  const emittedConstants = new Set<string>();

  for (const node of nodes) {
    for (const constant of parseReferencedConstants(
      readAttr(node, 'mdbg_constants'),
    )) {
      if (emittedConstants.has(constant)) {
        continue;
      }
      emittedConstants.add(constant);
      chunks.push(constant);
    }

    const opText = readAttr(node, 'op_text');
    if (opText != null && opText !== '') {
      chunks.push(opText);
    }
  }

  return chunks.join('\n');
}

export function parseReferencedConstants(
  constantsText: string | undefined,
): string[] {
  if (constantsText == null || constantsText === '') {
    return [];
  }

  return constantsText
    .split(/\r?\n/)
    .map((line) => stripConstantBindingLabel(line))
    .filter((line) => line !== '');
}

function nodeMatchesToken(node: OpNode, token: string): boolean {
  if (token.startsWith(NODE_ID_PREFIX)) {
    return node.id === token.substring(NODE_ID_PREFIX.length);
  }

  const sourceSsa = readAttr(node, SSA_ATTR_KEY);
  return (
    sourceSsa === token ||
    splitSsaTokens(sourceSsa).some((ssaToken) => ssaToken === token)
  );
}

function isOpNode(node: ModelNode | undefined): node is OpNode {
  return node?.nodeType === NodeType.OP_NODE;
}

function stripConstantBindingLabel(line: string): string {
  const separatorIndex = line.indexOf(': ');
  if (separatorIndex === -1) {
    return line.trim();
  }
  return line.substring(separatorIndex + 2).trim();
}

function readOrder(node: OpNode): number {
  const order = Number.parseInt(readAttr(node, 'mdbg_order') ?? '', 10);
  return Number.isFinite(order) ? order : MISSING_ORDER;
}
