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

/** Highlight strength for focused graph nodes. */
export type HighlightTier = 'primary' | 'subtle' | 'dimmed' | 'none';

/** State inputs used to compute focus-view node highlight tiers. */
export interface NodeHighlightFocusState {
  focusedNodeId?: string;
  focusPathNodeIds?: ReadonlySet<string>;
  retainedOutputNodeIds?: ReadonlySet<string>;
  disabledTracingNodeIds?: ReadonlySet<string>;
}

/** Computes semantic highlight tiers before renderer-specific styling. */
export class NodeHighlightStateManager {
  getHighlightTiers(
    nodeIds: Iterable<string>,
    focusState: NodeHighlightFocusState,
  ): Map<string, HighlightTier> {
    const tiers = new Map<string, HighlightTier>();
    const focusActive =
      focusState.focusedNodeId != null && focusState.focusedNodeId !== '';

    for (const nodeId of nodeIds) {
      tiers.set(nodeId, 'none');
    }

    if (!focusActive) {
      return tiers;
    }

    for (const nodeId of nodeIds) {
      if (
        nodeId === focusState.focusedNodeId ||
        focusState.focusPathNodeIds?.has(nodeId) === true
      ) {
        tiers.set(nodeId, 'primary');
      } else if (focusState.retainedOutputNodeIds?.has(nodeId) === true) {
        tiers.set(nodeId, 'subtle');
      } else {
        // Reserved for issue #131. Keep disabled tracing nodes unhighlighted.
        tiers.set(nodeId, 'none');
      }
    }

    return tiers;
  }
}
