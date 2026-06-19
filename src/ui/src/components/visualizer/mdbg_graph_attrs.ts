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

export const SSA_ATTR_KEY = 'mdbg_source_ssa';

export interface NodeToken {
  token: string;
  label?: string;
}

export function readAttr(
  node: ModelNode | undefined,
  key: string,
): string | undefined {
  if (!isOpNode(node) || node.attrs == null) {
    return undefined;
  }

  const attrs: unknown = node.attrs;
  if (Array.isArray(attrs)) {
    const attr = attrs.find((item) => {
      if (item == null || typeof item !== 'object') {
        return false;
      }
      return (item as Record<string, unknown>)['key'] === key;
    });
    const value =
      attr != null && typeof attr === 'object'
        ? (attr as Record<string, unknown>)['value']
        : undefined;
    return typeof value === 'string' ? value : undefined;
  }

  if (typeof attrs !== 'object') {
    return undefined;
  }
  const value = (attrs as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function isOpNode(node: ModelNode | undefined): node is OpNode {
  return node?.nodeType === NodeType.OP_NODE;
}

function isOutputsNode(node: ModelNode): boolean {
  if (node.label === 'GraphOutputs' || node.label === 'Outputs') {
    return true;
  }
  return readAttr(node, 'mdbg_kind') === 'function_output';
}

export function splitSsaTokens(sourceSsa: string | undefined): string[] {
  return (sourceSsa ?? '')
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token !== '');
}

export function getNodeToken(node: OpNode): NodeToken {
  const isFunctionOutput = readAttr(node, 'mdbg_kind') === 'function_output';
  if (isFunctionOutput) {
    return {
      token: `nodeId:${node.id}`,
      label: getOutputNodeLabel(node),
    };
  }

  const sourceSsa = readAttr(node, SSA_ATTR_KEY);
  if (sourceSsa != null && sourceSsa !== '') {
    return {token: sourceSsa};
  }

  return {token: `nodeId:${node.id}`};
}

export function getOutputNodeSsas(modelGraph: ModelGraph | undefined): string[] {
  const outputNodes =
    modelGraph?.nodes?.filter((node) => isOutputsNode(node)) ?? [];
  const mdbgOutputs = outputNodes
    .filter((node) => readAttr(node, 'mdbg_kind') === 'function_output')
    .sort((a, b) => {
      return (
        Number(readAttr(a, 'mdbg_output_index') ?? '0') -
        Number(readAttr(b, 'mdbg_output_index') ?? '0')
      );
    })
    .map((node) => readAttr(node, SSA_ATTR_KEY) ?? '');

  if (mdbgOutputs.length > 0) {
    return mdbgOutputs;
  }

  const graphOutputsNode = outputNodes.find((node) => isOpNode(node));
  if (!graphOutputsNode || !isOpNode(graphOutputsNode)) {
    return [];
  }

  return [...(graphOutputsNode.incomingEdges || [])]
    .sort((a, b) => {
      return Number(a.targetNodeInputId) - Number(b.targetNodeInputId);
    })
    .map((edge) => {
      const sourceNode = modelGraph?.nodesById?.[edge.sourceNodeId];
      if (!isOpNode(sourceNode)) {
        return '';
      }
      const sourceSsa = readAttr(sourceNode, SSA_ATTR_KEY);
      if (sourceSsa != null && sourceSsa !== '') {
        return sourceSsa;
      }
      const outputSsa =
        sourceNode.outputsMetadata?.[edge.sourceNodeOutputId]?.[SSA_ATTR_KEY];
      return typeof outputSsa === 'string' ? outputSsa : '';
    });
}

function getOutputNodeLabel(node: OpNode): string {
  const separatorIndex = node.id.lastIndexOf('::');
  if (separatorIndex !== -1) {
    return node.id.substring(separatorIndex + 2);
  }
  return node.label || node.id;
}
