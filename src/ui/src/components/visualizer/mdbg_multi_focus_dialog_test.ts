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

import {ModelGraph, NodeType, OpNode} from './common/model_graph';
import {MdbgMultiFocusDialogComponent} from './mdbg_multi_focus_dialog';

describe('MdbgMultiFocusDialogComponent', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [MdbgMultiFocusDialogComponent],
    });
  });

  it('should_enumerate_mdbg_per_output_nodes_by_output_index', () => {
    const outputNodes = [0, 1, 2].map((index) => {
      return {
        id: `outputs${index}`,
        label: `outputs${index}`,
        namespace: '',
        level: 0,
        nodeType: NodeType.OP_NODE,
        attrs: [
          {key: 'mdbg_kind', value: 'function_output'},
          {key: 'mdbg_output_index', value: String(index)},
          {key: 'mdbg_source_ssa', value: `%val${index}`},
        ],
      } as unknown as OpNode;
    });
    const fixture = TestBed.createComponent(MdbgMultiFocusDialogComponent);
    fixture.componentInstance.modelGraph = {
      nodes: outputNodes,
      nodesById: Object.fromEntries(outputNodes.map((node) => [node.id, node])),
    } as ModelGraph;

    expect(
      (
        fixture.componentInstance as unknown as {
          getOutputNodeSsas(): string[];
        }
      ).getOutputNodeSsas(),
    ).toEqual(['%val0', '%val1', '%val2']);
  });
});
