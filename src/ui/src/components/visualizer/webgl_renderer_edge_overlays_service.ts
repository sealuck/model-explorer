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
import {GroupNode, ModelEdge, ModelNode} from './common/model_graph';
import {getIntersectionPoints} from './common/utils';
import {EdgeOverlaysService} from './edge_overlays_service';
import {ThreejsService} from './threejs_service';
import {ColorVariable} from './visualizer_theme_service';
import {WebglEdges} from './webgl_edges';
import {WebglRenderer} from './webgl_renderer';
import {WebglRendererThreejsService} from './webgl_renderer_threejs_service';
import {WebglTexts} from './webgl_texts';

const THREE = three;

const DEFAULT_EDGE_WIDTH = 1.5;
const STORAGE_OVERVIEW_EDGE_WIDTH = 1;
const STORAGE_HIGHLIGHT_EDGE_WIDTH = 3;
const STORAGE_OVERVIEW_SURFACE_MIX = 0.5;
const STORAGE_BACKGROUND_SURFACE_MIX = 0.8;

interface QueueItem {
  nodeId: string;
  hops: number;
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
    // Most overlays activate around a selected member Node. Always-visible
    // overlays instead provide stable semantic topology, such as logical
    // memory content flow, even before the user selects a Node.
    const selectedOverlays = this.edgeOverlaysService.selectedOverlays();
    for (const selectedOverlay of selectedOverlays) {
      if (
        selectedOverlay.alwaysVisible === true ||
        (selectedNodeId !== '' && selectedOverlay.nodeIds.has(selectedNodeId))
      ) {
        this.curOverlays.push(selectedOverlay);
      }
    }
  }

  /** Return the active Storage legend item when it is currently rendered. */
  getHighlightedStorageOverlay(): ProcessedEdgeOverlay | undefined {
    const highlightedId =
      this.edgeOverlaysService.highlightedOverlayId();
    if (!highlightedId) {
      return undefined;
    }
    return this.curOverlays.find(
      (overlay) =>
        overlay.id === highlightedId &&
        Boolean(overlay.storageFocusSelector),
    );
  }

  /**
   * Project active Storage members onto the current expanded namespace view.
   * Explicit members cover one-operation paths; edge endpoints cover ordinary
   * paths. Hidden descendants map to their nearest rendered group node.
   */
  getHighlightedRenderedNodeIds(): Set<string> {
    const result = new Set<string>();
    const overlay = this.getHighlightedStorageOverlay();
    if (!overlay) {
      return result;
    }
    for (const nodeId of overlay.nodeIds) {
      const renderedNode = this.getRenderedEndpoint(nodeId);
      if (renderedNode) {
        result.add(renderedNode.id);
      }
    }
    return result;
  }

  clearOverlaysData() {
    this.curOverlays = [];
  }

  updateOverlaysEdges() {
    this.clearOverlaysEdges();

    if (this.curOverlays.length === 0) {
      return;
    }

    // Keep track of number of edges for a given pair of nodes. If there are
    // more than 1 edges, we will shift the edges to avoid overlapping.
    //
    // From sorted edge key (nodeId1->nodeId2) to the number of edges for that
    // pair.
    const seenEdgePairs: Record<string, number> = {};
    const totalEdgePairs: Record<string, number> = {};
    const visibleEdgesByOverlay = this.curOverlays.map((overlay) =>
      this.getVisibleEdges(overlay),
    );
    const highlightedStorage = this.getHighlightedStorageOverlay();

    // Populate totalEdgePairs.
    for (let i = 0; i < this.curOverlays.length; i++) {
      for (const edge of visibleEdgesByOverlay[i]) {
        const {sourceNodeId, targetNodeId} = edge;
        this.addToEdgePairs(sourceNodeId, targetNodeId, totalEdgePairs);
      }
    }

    for (let i = 0; i < this.curOverlays.length; i++) {
      const subgraph = this.curOverlays[i];
      const isStorageOverlay = Boolean(subgraph.storageFocusSelector);
      const isHighlighted = highlightedStorage?.id === subgraph.id;
      const edgeWidth = isStorageOverlay
        ? isHighlighted
          ? STORAGE_HIGHLIGHT_EDGE_WIDTH
          : STORAGE_OVERVIEW_EDGE_WIDTH
        : subgraph.edgeWidth ?? DEFAULT_EDGE_WIDTH;
      const edgeColor = this.getOverlayEdgeColor(
        subgraph,
        highlightedStorage,
      );
      const edges: Array<{edge: ModelEdge; index: number}> = [];
      const curWebglEdges = new WebglEdges(
        edgeWidth,
        edgeWidth / DEFAULT_EDGE_WIDTH,
      );
      for (const edge of visibleEdgesByOverlay[i]) {
        const {sourceNodeId, targetNodeId, label} = edge;

        const sourceNode = this.webglRenderer.curModelGraph.nodesById[
          sourceNodeId
        ];
        const targetNode = this.webglRenderer.curModelGraph.nodesById[
          targetNodeId
        ];
        if (!sourceNode || !targetNode) {
          continue;
        }
        const curEdgesCount = this.addToEdgePairs(
          sourceNodeId,
          targetNodeId,
          seenEdgePairs,
        );
        const totalEdgesCount =
          totalEdgePairs[this.getEdgeKey(sourceNodeId, targetNodeId)];
        const xOffsetFactor = (1 / (totalEdgesCount + 1)) * curEdgesCount - 0.5;
        const {intersection1, intersection2} = getIntersectionPoints(
          this.webglRenderer.getNodeRect(sourceNode),
          this.webglRenderer.getNodeRect(targetNode),
          xOffsetFactor,
        );
        // Edge.
        edges.push({
          edge: {
            id:
              edge.id ?? `overlay_edge_${i}_${sourceNodeId}_${targetNodeId}`,
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
        edgeColor,
        edges,
        this.webglRenderer.curModelGraph,
      );
      this.webglRendererThreejsService.addToScene(curWebglEdges.edgesMesh);
      this.webglRendererThreejsService.addToScene(curWebglEdges.arrowHeadsMesh);
      this.overlaysEdgesList.push(curWebglEdges);

      // Edge labels.
      // Storage overview labels overwhelm large bufferized graphs. Exact
      // access/content labels return when that one Storage is highlighted.
      const labels =
        !isStorageOverlay || isHighlighted
          ? this.webglRenderer.webglRendererEdgeTextsService.genLabelsOnEdges(
              edges,
              edgeColor,
              edgeWidth / 2,
              96.5,
              subgraph.edgeLabelFontSize ?? 7.5,
            )
          : [];
      const curWebglTexts = new WebglTexts(this.threejsService);
      curWebglTexts.generateMesh(labels, true, false, true);
      this.webglRendererThreejsService.addToScene(curWebglTexts.mesh);
      this.overlaysEdgeTextsList.push(curWebglTexts);
    }
  }

  /**
   * Projects semantic edges onto the currently rendered namespace frontier.
   *
   * A collapsed group hides all of its OpNodes. Drawing their original overlay
   * coordinates creates lines and labels at stale/default positions. Promote a
   * hidden endpoint to its nearest rendered ancestor and coalesce duplicate
   * relations between the same visible pair. Exact labels return automatically
   * when both endpoint Ops are visible again.
   */
  private getVisibleEdges(edgeOverlay: ProcessedEdgeOverlay): Edge[] {
    const visibleByPair = new Map<string, Edge>();
    for (const edge of edgeOverlay.edges) {
      if (!this.shouldShowEdge(edgeOverlay, edge)) {
        continue;
      }
      const source = this.getRenderedEndpoint(edge.sourceNodeId);
      const target = this.getRenderedEndpoint(edge.targetNodeId);
      if (!source || !target || source.id === target.id) {
        continue;
      }

      const key = `${source.id}\u0000${target.id}`;
      if (visibleByPair.has(key)) {
        continue;
      }
      const endpointsAreExact =
        source.id === edge.sourceNodeId && target.id === edge.targetNodeId;
      visibleByPair.set(key, {
        ...edge,
        sourceNodeId: source.id,
        targetNodeId: target.id,
        label: endpointsAreExact ? edge.label : '',
      });
    }
    return [...visibleByPair.values()];
  }

  /** Returns the Node or collapsed ancestor that owns visible coordinates. */
  private getRenderedEndpoint(nodeId: string): ModelNode | undefined {
    let node: ModelNode | undefined =
      this.webglRenderer.curModelGraph.nodesById[nodeId];
    while (node && !this.webglRenderer.isNodeRendered(node.id)) {
      node = node.nsParentId
        ? this.webglRenderer.curModelGraph.nodesById[node.nsParentId]
        : undefined;
    }
    return node;
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
    // Semantic overview/legend overlays project endpoints to the current
    // namespace frontier. They must never expand a large graph as a side
    // effect of selecting a Node or legend item.
    const overlaysToReveal = this.curOverlays.filter(
      (overlay) => overlay.alwaysVisible !== true,
    );
    for (const subgraph of overlaysToReveal) {
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

  /** Resolve a theme-aware weak or highlighted edge color for one overlay. */
  private getOverlayEdgeColor(
    overlay: ProcessedEdgeOverlay,
    highlightedStorage: ProcessedEdgeOverlay | undefined,
  ): three.Color {
    const color = new THREE.Color(overlay.edgeColor);
    if (!overlay.storageFocusSelector) {
      return color;
    }
    if (highlightedStorage?.id === overlay.id) {
      return color;
    }
    const surface = new THREE.Color(
      this.webglRenderer.visualizerThemeService.getColor(
        ColorVariable.SURFACE_COLOR,
      ),
    );
    return color.lerp(
      surface,
      highlightedStorage
        ? STORAGE_BACKGROUND_SURFACE_MIX
        : STORAGE_OVERVIEW_SURFACE_MIX,
    );
  }

  private addToEdgePairs(
    nodeId1: string,
    nodeId2: string,
    pairs: Record<string, number>,
  ): number {
    const key = this.getEdgeKey(nodeId1, nodeId2);
    if (pairs[key] === undefined) {
      pairs[key] = 0;
    }
    pairs[key]++;
    return pairs[key];
  }

  private getEdgeKey(nodeId1: string, nodeId2: string): string {
    return nodeId1.localeCompare(nodeId2) < 0
      ? `${nodeId1}___${nodeId2}`
      : `${nodeId2}___${nodeId1}`;
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
