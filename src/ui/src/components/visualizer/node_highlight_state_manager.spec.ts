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

import {NodeHighlightStateManager} from './node_highlight_state_manager';
import {ModelNode, NodeType} from './common/model_graph';
import {isOutputsNode} from './common/utils';

describe('NodeHighlightStateManager', () => {
  let manager: NodeHighlightStateManager;

  beforeEach(() => {
    manager = new NodeHighlightStateManager();
  });

  it('should_return_none_when_no_focus_active', () => {
    const tiers = manager.getHighlightTiers(['a', 'GraphOutputs'], {
      retainedOutputNodeIds: new Set(['GraphOutputs']),
    });

    expect(tiers.get('a')).toBe('none');
    expect(tiers.get('GraphOutputs')).toBe('none');
  });

  it('should_return_primary_for_focus_path_nodes', () => {
    const tiers = manager.getHighlightTiers(['focus', 'path', 'other'], {
      focusedNodeId: 'focus',
      focusPathNodeIds: new Set(['path']),
    });

    expect(tiers.get('focus')).toBe('primary');
    expect(tiers.get('path')).toBe('primary');
  });

  it('should_return_subtle_for_retained_output_nodes', () => {
    const tiers = manager.getHighlightTiers(['focus', 'GraphOutputs'], {
      focusedNodeId: 'focus',
      focusPathNodeIds: new Set(['focus']),
      retainedOutputNodeIds: new Set(['GraphOutputs']),
    });

    expect(tiers.get('GraphOutputs')).toBe('subtle');
  });

  it('should_match_viewer_model_output_nodes', () => {
    const node = {
      id: 'output-0',
      label: 'outputs0',
      namespace: '',
      level: 0,
      nodeType: NodeType.OP_NODE,
      attrs: [{key: 'viewer.node_kind', value: 'model_output'}],
    } as unknown as ModelNode;

    expect(isOutputsNode(node)).toBeTrue();
  });

  it('should_return_none_for_unrelated_nodes', () => {
    const tiers = manager.getHighlightTiers(['focus', 'unrelated'], {
      focusedNodeId: 'focus',
      focusPathNodeIds: new Set(['focus']),
      retainedOutputNodeIds: new Set(['GraphOutputs']),
    });

    expect(tiers.get('unrelated')).toBe('none');
  });
});
