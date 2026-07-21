/**
 * @license
 * Copyright 2026 The Model Explorer Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * ==============================================================================
 */

import {AppService} from './app_service';
import {EdgeOverlaysData} from './common/edge_overlays';
import {TaskType} from './common/task';
import {EdgeOverlaysService, processOverlay} from './edge_overlays_service';

const STORAGE_LEGEND: EdgeOverlaysData = {
  type: TaskType.EDGE_OVERLAYS,
  name: 'Memory content',
  selectionMode: 'single_highlight',
  overlays: [
    {
      name: '%alloc',
      edgeColor: '#4477AA',
      edges: [],
      memberNodeIds: ['writer'],
      alwaysVisible: true,
      storageFocusSelector: '@main::%alloc',
    },
    {
      name: '%alloc_1',
      edgeColor: '#EE6677',
      edges: [],
      memberNodeIds: ['reader'],
      alwaysVisible: true,
      storageFocusSelector: '@main::%alloc_1',
    },
  ],
};

describe('EdgeOverlaysService', () => {
  it('keeps explicit members when a storage path has no rendered edge', () => {
    const processed = processOverlay(STORAGE_LEGEND);

    expect([...processed.processedOverlays[0].nodeIds]).toEqual(['writer']);
  });

  it('selects at most one legend highlight and toggles it off', () => {
    const service = new EdgeOverlaysService({} as AppService);
    service.addEdgeOverlayData(STORAGE_LEGEND);
    const overlays = service.allLoadedEdgeOverlays()[0].processedOverlays;
    const firstOverlayId = overlays[0].id;
    const secondOverlayId = overlays[1].id;

    service.toggleOverlayHighlight(firstOverlayId);
    expect(service.highlightedOverlayId()).toBe(firstOverlayId);

    service.toggleOverlayHighlight(secondOverlayId);
    expect(service.highlightedOverlayId()).toBe(secondOverlayId);

    service.toggleOverlayHighlight(secondOverlayId);
    expect(service.highlightedOverlayId()).toBe('');
  });

  it('preserves checkbox visibility selection for ordinary overlays', () => {
    const service = new EdgeOverlaysService({} as AppService);
    service.addEdgeOverlayData({
      type: TaskType.EDGE_OVERLAYS,
      name: 'Custom',
      overlays: [
        {
          name: 'custom',
          edgeColor: '#000000',
          edges: [{sourceNodeId: 'a', targetNodeId: 'b'}],
        },
      ],
    });
    const overlayId = service.allLoadedEdgeOverlays()[0].processedOverlays[0].id;

    expect(service.selectedOverlayIds()).toEqual([overlayId]);
    service.toggleOverlaySelection(overlayId);
    expect(service.selectedOverlayIds()).toEqual([]);
    expect(service.highlightedOverlayId()).toBe('');
  });
});
