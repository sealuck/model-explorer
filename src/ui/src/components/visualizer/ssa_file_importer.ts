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

export interface SsaFileImportUnresolvedLine {
  line: string;
  reason: string;
}

export interface SsaFileImportResult {
  resolved: string[];
  unresolved: SsaFileImportUnresolvedLine[];
}

const OUTPUT_ALIAS_RE = /^(?:output|outputs|item|items)(\d+)$/i;

export function importFromLines(
  lines: string[],
  outputNodeSsas: string[],
): SsaFileImportResult {
  const resolved: string[] = [];
  const unresolved: SsaFileImportUnresolvedLine[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }

    if (line.startsWith('%')) {
      resolved.push(line);
      continue;
    }

    const match = line.match(OUTPUT_ALIAS_RE);
    if (match) {
      const index = Number.parseInt(match[1], 10);
      if (index < outputNodeSsas.length) {
        resolved.push(outputNodeSsas[index]);
      } else {
        unresolved.push({line, reason: 'index out of range'});
      }
      continue;
    }

    unresolved.push({line, reason: 'unrecognized format'});
  }

  return {resolved, unresolved};
}
