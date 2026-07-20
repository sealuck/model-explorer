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

import {Edge} from './common/edge_overlays';
import {
  OverlayEdgeHitTarget,
  findClosestOverlayEdge,
  getStableEdgeLaneOffsets,
} from './webgl_renderer_edge_overlays_service';

describe('getStableEdgeLaneOffsets', () => {
  it('orders parallel edges by exact ports instead of input order', () => {
    const port2 = createEdge('edge-2', '2');
    const port0 = createEdge('edge-0', '0');
    const port1 = createEdge('edge-1', '1');

    const offsets = getStableEdgeLaneOffsets([port2, port0, port1]);

    expect(offsets.get(port0)).toBe(-0.25);
    expect(offsets.get(port1)).toBe(0);
    expect(offsets.get(port2)).toBe(0.25);
  });

  it('keeps each edge in the same lane after reload reorders overlays', () => {
    const edges = [
      createEdge('edge-0', '0'),
      createEdge('edge-1', '1'),
      createEdge('edge-2', '2'),
    ];

    const forward = getStableEdgeLaneOffsets(edges);
    const reversed = getStableEdgeLaneOffsets([...edges].reverse());

    for (const edge of edges) {
      expect(reversed.get(edge)).toBe(forward.get(edge));
    }
  });

  it('sorts synthetic port suffixes numerically', () => {
    const port10 = createEdge('edge-10', '0', 'buffer:10');
    const port2 = createEdge('edge-2', '0', 'buffer:2');

    const offsets = getStableEdgeLaneOffsets([port10, port2]);

    expect(offsets.get(port2)).toBeLessThan(offsets.get(port10)!);
  });
});

describe('findClosestOverlayEdge', () => {
  it('returns only the nearest edge inside the hit radius', () => {
    const near = createHitTarget('near', 0);
    const far = createHitTarget('far', 10);

    expect(findClosestOverlayEdge([far, near], {x: 5, y: 1}, 2)).toBe(near);
    expect(findClosestOverlayEdge([near, far], {x: 5, y: 5}, 2)).toBeUndefined();
  });
});

function createEdge(id: string, portId: string, sourcePort?: string): Edge {
  return {
    id,
    sourceNodeId: 'producer',
    targetNodeId: 'consumer',
    sourceNodeOutputId: sourcePort ?? `buffer:${portId}`,
    targetNodeInputId: portId,
  };
}

function createHitTarget(id: string, y: number): OverlayEdgeHitTarget {
  return {
    overlayId: `overlay-${id}`,
    edge: createEdge(id, id),
    start: {x: 0, y},
    end: {x: 10, y},
  };
}
