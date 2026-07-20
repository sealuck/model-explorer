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

import {Injectable, inject} from '@angular/core';
import * as three from 'three';
import {WEBGL_ELEMENT_Y_FACTOR} from './common/consts';
import {Edge, EdgeOverlay, ProcessedEdgeOverlay} from './common/edge_overlays';
import {GroupNode, ModelEdge, OpNode} from './common/model_graph';
import {getIntersectionPoints} from './common/utils';
import {EdgeOverlaysService} from './edge_overlays_service';
import {ThreejsService} from './threejs_service';
import {WebglEdges} from './webgl_edges';
import {WebglRenderer} from './webgl_renderer';
import {WebglRendererThreejsService} from './webgl_renderer_threejs_service';
import {WebglTexts} from './webgl_texts';

const THREE = three;

const DEFAULT_EDGE_WIDTH = 1.5;

interface QueueItem {
  nodeId: string;
  hops: number;
}

export interface Point {
  x: number;
  y: number;
}

/** One rendered overlay edge segment that can be selected by the user. */
export interface OverlayEdgeHitTarget {
  overlayId: string;
  edge: Edge;
  start: Point;
  end: Point;
}

function edgePairKey(edge: Edge): string {
  return edge.sourceNodeId.localeCompare(edge.targetNodeId) < 0
    ? `${edge.sourceNodeId}___${edge.targetNodeId}`
    : `${edge.targetNodeId}___${edge.sourceNodeId}`;
}

function comparePortIds(left = '', right = ''): number {
  const parse = (value: string) => {
    const match = /^(.*?)(\d+)$/.exec(value);
    if (!match) {
      return {category: 2, prefix: value, index: 0, value};
    }
    return {
      category: match[1] === '' ? 0 : 1,
      prefix: match[1],
      index: Number(match[2]),
      value,
    };
  };
  const leftPort = parse(left);
  const rightPort = parse(right);
  return (
    leftPort.category - rightPort.category ||
    leftPort.prefix.localeCompare(rightPort.prefix) ||
    leftPort.index - rightPort.index ||
    leftPort.value.localeCompare(rightPort.value)
  );
}

function compareLaneEdges(left: Edge, right: Edge): number {
  return (
    comparePortIds(left.targetNodeInputId, right.targetNodeInputId) ||
    comparePortIds(left.sourceNodeOutputId, right.sourceNodeOutputId) ||
    left.sourceNodeId.localeCompare(right.sourceNodeId) ||
    left.targetNodeId.localeCompare(right.targetNodeId) ||
    (left.id ?? '').localeCompare(right.id ?? '')
  );
}

/**
 * Returns centered lane offsets for every parallel Node-pair relation.
 * Sorting by exact ports and stable edge id makes the result independent of
 * overlay iteration order and therefore stable across layout/reload.
 */
export function getStableEdgeLaneOffsets(
  edges: readonly Edge[],
): Map<Edge, number> {
  const edgesByPair = new Map<string, Edge[]>();
  for (const edge of edges) {
    const key = edgePairKey(edge);
    const group = edgesByPair.get(key) ?? [];
    group.push(edge);
    edgesByPair.set(key, group);
  }

  const offsets = new Map<Edge, number>();
  for (const group of edgesByPair.values()) {
    group.sort(compareLaneEdges);
    for (let index = 0; index < group.length; index++) {
      offsets.set(group[index], (index + 1) / (group.length + 1) - 0.5);
    }
  }
  return offsets;
}

function squaredDistanceToSegment(point: Point, start: Point, end: Point) {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const lengthSquared = deltaX * deltaX + deltaY * deltaY;
  if (lengthSquared === 0) {
    return (point.x - start.x) ** 2 + (point.y - start.y) ** 2;
  }
  const projection = Math.max(
    0,
    Math.min(
      1,
      ((point.x - start.x) * deltaX + (point.y - start.y) * deltaY) /
        lengthSquared,
    ),
  );
  const closestX = start.x + projection * deltaX;
  const closestY = start.y + projection * deltaY;
  return (point.x - closestX) ** 2 + (point.y - closestY) ** 2;
}

/** Returns the nearest visible edge within the caller's scene-space radius. */
export function findClosestOverlayEdge(
  targets: readonly OverlayEdgeHitTarget[],
  point: Point,
  maxDistance: number,
): OverlayEdgeHitTarget | undefined {
  let closest: OverlayEdgeHitTarget | undefined;
  let closestDistance = maxDistance * maxDistance;
  for (const target of targets) {
    const distance = squaredDistanceToSegment(point, target.start, target.end);
    if (distance < closestDistance) {
      closest = target;
      closestDistance = distance;
    }
  }
  return closest;
}

/**
 * Service for managing edge overlays related tasks in webgl renderer.
 */
@Injectable()
export class WebglRendererEdgeOverlaysService {
  private readonly threejsService: ThreejsService = inject(ThreejsService);

  private webglRenderer!: WebglRenderer;
  private webglRendererThreejsService!: WebglRendererThreejsService;
  private overlaysEdgesList: WebglEdges[] = [];
  private overlaysEdgeTextsList: WebglTexts[] = [];
  private bfsEdgeCache: Map<string, Set<Edge>> = new Map();
  private renderedOverlayEdges: OverlayEdgeHitTarget[] = [];

  hoveredOverlayEdge: OverlayEdgeHitTarget | undefined;

  readonly edgeOverlaysService = inject(EdgeOverlaysService);
  curOverlays: ProcessedEdgeOverlay[] = [];

  init(webglRenderer: WebglRenderer) {
    this.webglRenderer = webglRenderer;
    this.webglRendererThreejsService =
      webglRenderer.webglRendererThreejsService;
  }

  updateOverlaysData() {
    this.clearOverlaysData();

    const selectedNodeId = this.webglRenderer.selectedNodeId;
    if (!selectedNodeId) {
      return;
    }

    // Find overlays that contain the node from the selected overlays.
    const selectedOverlays = this.edgeOverlaysService.selectedOverlays();
    for (const selectedOverlay of selectedOverlays) {
      if (selectedOverlay.nodeIds.has(selectedNodeId)) {
        this.curOverlays.push(selectedOverlay);
      }
    }
  }

  clearOverlaysData() {
    this.curOverlays = [];
  }

  updateOverlaysEdges() {
    this.clearOverlaysEdges();

    if (this.curOverlays.length === 0) {
      return;
    }

    const visibleEdges: Edge[] = [];
    for (const subgraph of this.curOverlays) {
      for (const edge of subgraph.edges) {
        if (!this.shouldShowEdge(subgraph, edge)) {
          continue;
        }
        const sourceNode = this.webglRenderer.curModelGraph.nodesById[
          edge.sourceNodeId
        ] as OpNode;
        const targetNode = this.webglRenderer.curModelGraph.nodesById[
          edge.targetNodeId
        ] as OpNode;
        if (sourceNode && targetNode) {
          visibleEdges.push(edge);
        }
      }
    }
    const laneOffsets = getStableEdgeLaneOffsets(visibleEdges);

    for (let i = 0; i < this.curOverlays.length; i++) {
      const subgraph = this.curOverlays[i];
      const edgeWidth = subgraph.edgeWidth ?? DEFAULT_EDGE_WIDTH;
      const edges: Array<{edge: ModelEdge; index: number}> = [];
      const curWebglEdges = new WebglEdges(
        edgeWidth,
        edgeWidth / DEFAULT_EDGE_WIDTH,
      );
      for (
        let edgeOrdinal = 0;
        edgeOrdinal < subgraph.edges.length;
        edgeOrdinal++
      ) {
        const edge = subgraph.edges[edgeOrdinal];
        const {sourceNodeId, targetNodeId, label} = edge;
        if (!this.shouldShowEdge(subgraph, edge)) {
          continue;
        }

        const sourceNode = this.webglRenderer.curModelGraph.nodesById[
          sourceNodeId
        ] as OpNode;
        const targetNode = this.webglRenderer.curModelGraph.nodesById[
          targetNodeId
        ] as OpNode;
        if (!sourceNode || !targetNode) {
          continue;
        }
        const xOffsetFactor = laneOffsets.get(edge) ?? 0;
        const {intersection1, intersection2} = getIntersectionPoints(
          this.webglRenderer.getNodeRect(sourceNode),
          this.webglRenderer.getNodeRect(targetNode),
          xOffsetFactor,
        );
        this.renderedOverlayEdges.push({
          overlayId: subgraph.id,
          edge,
          start: intersection1,
          end: intersection2,
        });
        // Edge.
        edges.push({
          edge: {
            id:
              edge.id ||
              `overlay_edge_${i}_${edgeOrdinal}_${sourceNodeId}:` +
                `${edge.sourceNodeOutputId ?? ''}->${targetNodeId}:` +
                `${edge.targetNodeInputId ?? ''}`,
            fromNodeId: sourceNodeId,
            toNodeId: targetNodeId,
            label: label ?? '',
            points: [],
            curvePoints: [
              {
                x: intersection1.x - (sourceNode?.globalX || 0),
                y: intersection1.y - (sourceNode?.globalY || 0),
              },
              {
                x: intersection2.x - (sourceNode.globalX || 0),
                y: intersection2.y - (sourceNode.globalY || 0),
              },
            ],
          },
          // Use anything > 95 which is used for rendering io highlight edges.
          index: 96 / WEBGL_ELEMENT_Y_FACTOR,
        });
      }
      curWebglEdges.generateMesh(
        new THREE.Color(subgraph.edgeColor),
        edges,
        this.webglRenderer.curModelGraph,
      );
      this.webglRendererThreejsService.addToScene(curWebglEdges.edgesMesh);
      this.webglRendererThreejsService.addToScene(curWebglEdges.arrowHeadsMesh);
      this.overlaysEdgesList.push(curWebglEdges);

      // Edge labels.
      const labels =
        this.webglRenderer.webglRendererEdgeTextsService.genLabelsOnEdges(
          edges,
          new THREE.Color(subgraph.edgeColor),
          edgeWidth / 2,
          96.5,
          subgraph.edgeLabelFontSize ?? 7.5,
        );
      const curWebglTexts = new WebglTexts(this.threejsService);
      curWebglTexts.generateMesh(labels, true, false, true);
      this.webglRendererThreejsService.addToScene(curWebglTexts.mesh);
      this.overlaysEdgeTextsList.push(curWebglTexts);
    }
  }

  clearOverlaysEdges() {
    for (const webglEdges of this.overlaysEdgesList) {
      webglEdges.clear();
    }
    for (const webglTexts of this.overlaysEdgeTextsList) {
      if (webglTexts.mesh && webglTexts.mesh.geometry) {
        webglTexts.mesh.geometry.dispose();
        this.webglRendererThreejsService.removeFromScene(webglTexts.mesh);
      }
    }

    this.overlaysEdgesList = [];
    this.overlaysEdgeTextsList = [];
    this.renderedOverlayEdges = [];
    this.hoveredOverlayEdge = undefined;
  }

  updateHoveredOverlayEdge(point: Point, maxDistance: number): boolean {
    this.hoveredOverlayEdge = findClosestOverlayEdge(
      this.renderedOverlayEdges,
      point,
      maxDistance,
    );
    return this.hoveredOverlayEdge != null;
  }

  clearHoveredOverlayEdge() {
    this.hoveredOverlayEdge = undefined;
  }

  getDeepestExpandedGroupNodeIds(): string[] {
    if (this.curOverlays.length === 0) {
      return [];
    }

    const ids = new Set<string>();

    const addNsParentId = (nodeId: string) => {
      const node = this.webglRenderer.curModelGraph.nodesById[nodeId];
      if (node?.nsParentId) {
        const parentNode = this.webglRenderer.curModelGraph.nodesById[
          node.nsParentId
        ] as GroupNode;
        if (
          !parentNode.expanded ||
          !this.webglRenderer.isNodeRendered(parentNode.id)
        ) {
          ids.add(node.nsParentId);
        }
      }
    };
    for (const subgraph of this.curOverlays) {
      for (const edge of subgraph.edges) {
        const {sourceNodeId, targetNodeId} = edge;
        if (!this.shouldShowEdge(subgraph, edge)) {
          continue;
        }

        addNsParentId(sourceNodeId);
        addNsParentId(targetNodeId);
      }
    }
    return [...ids];
  }

  /**
   * Determines whether a given edge should be visible.
   *
   * This function first checks if the `edgeOverlay` is configured to show
   * only edges connected to the selected node. If not, all edges are visible,
   * and the function returns `true`.
   *
   * If the overlay is restricted, a Breadth-First Search (BFS) is performed
   * starting from the `selectedNodeId`. The search explores the graph up to
   * `visibleEdgeHops`. If the provided `edge` is encountered during
   * this search, it is considered visible and the function returns `true`.
   *
   * If the BFS completes without finding the edge, it means the edge is
   * outside the specified range from the selected node, and the function
   * returns `false`.
   */
  private shouldShowEdge(
    edgeOverlay: ProcessedEdgeOverlay,
    edge: Edge,
  ): boolean {
    if (!edgeOverlay.showEdgesConnectedToSelectedNodeOnly) {
      return true;
    }

    const selectedNodeId = this.webglRenderer.selectedNodeId;
    const maxHops = edgeOverlay.visibleEdgeHops ?? 1;

    // Perform BFS to find all the edges connected to the selected node within
    // the given number of hops.
    //
    // Try to find the result in the cache.
    const cacheKey = `${maxHops}-${edgeOverlay.id}-${selectedNodeId}`;
    if (this.bfsEdgeCache.has(cacheKey)) {
      const foundEdges = this.bfsEdgeCache.get(cacheKey)!;
      return foundEdges.has(edge);
    }

    // Not found in the cache, so we perform BFS.
    const queue: QueueItem[] = [{nodeId: selectedNodeId, hops: 0}];
    const visitedNodes = new Set<string>();
    const foundEdges = new Set<Edge>();

    visitedNodes.add(selectedNodeId);

    let head = 0;
    while (head < queue.length) {
      const {nodeId: currentNodeId, hops: currentHops} = queue[head++];

      // If we have reached the maximum number of hops, we stop exploring
      // further.
      if (currentHops >= maxHops) {
        continue;
      }

      // Get the neighbors of the current node from the adjacency map.
      const neighboringEdges =
        edgeOverlay.adjacencyMap.get(currentNodeId) || [];
      for (const curEdge of neighboringEdges) {
        foundEdges.add(curEdge);

        // Determine the next node to visit.
        const nextNodeId =
          curEdge.sourceNodeId === currentNodeId
            ? curEdge.targetNodeId
            : curEdge.sourceNodeId;

        // If we haven't visited this node yet, add it to the queue for the next
        // step.
        if (!visitedNodes.has(nextNodeId)) {
          visitedNodes.add(nextNodeId);
          queue.push({nodeId: nextNodeId, hops: currentHops + 1});
        }
      }
    }

    // Add the result to the cache.
    this.bfsEdgeCache.set(cacheKey, foundEdges);

    return foundEdges.has(edge);
  }
}
