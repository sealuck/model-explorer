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

import {ModelGraph, ModelNode} from './common/model_graph';
import {isGroupNode, isOpNode} from './common/utils';
import {readAttr} from './mdbg_graph_attrs';

const SEED_ROLE_ATTR = 'mdbg_seed_role';
const SEED_ROLE_VALUE = 'seed';

export function collectSeedHighlightTargets(
  modelGraph: ModelGraph,
  isNodeRendered: (nodeId: string) => boolean,
): string[] {
  const targetIds = new Set<string>();

  for (const node of modelGraph.nodes) {
    if (!isOpNode(node) || readAttr(node, SEED_ROLE_ATTR) !== SEED_ROLE_VALUE) {
      continue;
    }

    const targetId = isNodeRendered(node.id)
      ? node.id
      : findRenderedAncestorGroupId(modelGraph, node, isNodeRendered);
    if (targetId) {
      targetIds.add(targetId);
    }
  }

  return [...targetIds];
}

function findRenderedAncestorGroupId(
  modelGraph: ModelGraph,
  node: ModelNode,
  isNodeRendered: (nodeId: string) => boolean,
): string | undefined {
  let parentId = node.nsParentId;
  const visited = new Set<string>();

  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = modelGraph.nodesById[parentId];
    if (!parent) {
      return undefined;
    }
    if (isGroupNode(parent) && isNodeRendered(parent.id)) {
      return parent.id;
    }
    parentId = parent.nsParentId;
  }

  return undefined;
}
