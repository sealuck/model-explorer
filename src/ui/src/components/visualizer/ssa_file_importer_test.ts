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

import {importFromLines} from './ssa_file_importer';

describe('importFromLines', () => {
  it('should_passthrough_direct_ssa_names', () => {
    expect(importFromLines(['%0', '  %arg1  '], []).resolved).toEqual([
      '%0',
      '%arg1',
    ]);
  });

  it('should_resolve_output_alias_to_ssa', () => {
    expect(importFromLines(['output1'], ['%0', '%1']).resolved).toEqual([
      '%1',
    ]);
  });

  it('should_resolve_outputs_alias_to_ssa', () => {
    expect(importFromLines(['outputs0'], ['%result']).resolved).toEqual([
      '%result',
    ]);
  });

  it('should_resolve_item_alias_to_ssa', () => {
    expect(importFromLines(['item1'], ['%a', '%b']).resolved).toEqual(['%b']);
  });

  it('should_resolve_items_alias_to_ssa', () => {
    expect(importFromLines(['items0'], ['%first']).resolved).toEqual([
      '%first',
    ]);
  });

  it('should_add_out_of_range_index_to_unresolved', () => {
    expect(importFromLines(['output2'], ['%0']).unresolved).toEqual([
      {line: 'output2', reason: 'index out of range'},
    ]);
  });

  it('should_skip_empty_lines', () => {
    expect(importFromLines(['', '   ', '%0'], []).resolved).toEqual(['%0']);
  });

  it('should_skip_comment_lines', () => {
    expect(importFromLines(['# comment', '  # comment', '%0'], []).resolved)
      .toEqual(['%0']);
  });

  it('should_handle_mixed_file', () => {
    const result = importFromLines(
      ['# comment', 'outputs1', '%direct', 'output9', 'bad'],
      ['%0', '%1'],
    );

    expect(result.resolved).toEqual(['%1', '%direct']);
    expect(result.unresolved).toEqual([
      {line: 'output9', reason: 'index out of range'},
      {line: 'bad', reason: 'unrecognized format'},
    ]);
  });
});
