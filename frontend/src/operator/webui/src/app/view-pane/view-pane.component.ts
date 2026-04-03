import {Component, OnInit, OnDestroy, AfterViewInit, AfterViewChecked, ViewChild, ElementRef, inject, DOCUMENT, ChangeDetectionStrategy} from '@angular/core';
import {DisplaysService} from '../displays.service';
import {
  asyncScheduler,
  BehaviorSubject,
  merge,
  fromEvent,
  Observable,
  Subscription,
} from 'rxjs';
import {map, debounceTime, scan, tap} from 'rxjs/operators';
import {
  KtdGridComponent,
  KtdGridLayout,
  KtdGridLayoutItem,
  ktdTrackById,
} from '@katoid/angular-grid-layout';
import {DisplayInfo} from '../../../../intercept/js/server_connector'

interface DeviceGridItem extends KtdGridLayoutItem {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  display_width: number | null;
  display_height: number | null;
  display_count: number;
  zoom: number;
  visible: boolean;
  placed: boolean;
  [key: string]: string | number | boolean | undefined | null;
}

interface DeviceGridItemUpdate {
  values: DeviceGridItem;
  overwrites: string[];
  source: string;
}

@Component({
  changeDetection: ChangeDetectionStrategy.Default,
  standalone: false,
  selector: 'app-view-pane',
  templateUrl: './view-pane.component.html',
  styleUrls: ['./view-pane.component.scss'],
})
export class ViewPaneComponent implements OnInit, OnDestroy, AfterViewInit, AfterViewChecked {
  @ViewChild(KtdGridComponent, { static: true })
  grid!: KtdGridComponent;
  @ViewChild('viewPane', { static: true })
  viewPane!: ElementRef;
  resizeSubscription!: Subscription;
  resizeObserver!: ResizeObserver;

  displaysService = inject(DisplaysService);
  document = inject<Document>(DOCUMENT);


  cols$ = new BehaviorSubject<number>(0);
  cols = 0;

  layoutUpdated$ = new BehaviorSubject<KtdGridLayout>([]);

  trackById = ktdTrackById;

  private readonly minPanelWidth = 330;
  private readonly minPanelHeight = 100;
  private readonly defaultDisplayWidth = 720;
  private readonly defaultDisplayHeight = 1280;
  private readonly defaultDisplayZoom = 0.5;

  // 10px (20 for left+right, 20 for top+bottom) on all four sides of each
  // display.
  private readonly displayMargin = 20;

  // Does not include vertical margins of display device (displayMargin)
  private readonly panelTitleHeight = 53;
  private readonly displayTitleHeight = 48;

  // Note this is constant because displays appear on a single horizontal row.
  private readonly totalVerticalSpacing
      = this.panelTitleHeight
      + this.displayTitleHeight
      + this.displayMargin;

  private totalHorizontalSpacing(item: DeviceGridItem): number {
    const iconPanelWidth = 58;
    const cnt = item.display_count || 1;

    // Separate displays are shown in a row left-to-right, so each new devices
    // adds more margin space.
    // Note we assume control-panel-custom-buttons are not visible. The risk is
    // that they really are, in which case the zoom will be over-calculated and
    // extra vertical space will appear below the displays. Ideally the device
    // would report how much spacing is required in each direction.
    return cnt * this.displayMargin + iconPanelWidth;
  }

  private currentLayout: DeviceGridItem[] = [];

  private compositeAnimationId: number | null = null;
  private compositeCheckInterval: ReturnType<typeof setInterval> | null = null;
  private compositeActive = false;
  private compositeOverlayVideo: HTMLVideoElement | null = null;
  private compositeOverlayIframe: HTMLIFrameElement | null = null;
  private compositeDebugLogged = false;

  private readonly freeScale = 0;

  ngOnInit(): void {
    this.resizeObserver = new ResizeObserver(entries => {
      this.cols$.next(entries[0].contentRect.width);
    });
    this.resizeObserver.observe(this.viewPane.nativeElement);
    this.cols$.subscribe(cols => {
      this.cols = cols;
    });
  }

  ngAfterViewInit(): void {
    this.resizeSubscription = merge(
      fromEvent(window, 'resize'),
      fromEvent(window, 'orientationchange')
    )
      .pipe(debounceTime(50))
      .subscribe(() => {
        this.grid.resize();
      });
  }

  ngAfterViewChecked(): void {
    if (!this.compositeActive && this.currentLayout.length >= 2) {
      const canvas = this.document.querySelector('canvas.composite-canvas') as HTMLCanvasElement;
      if (canvas) {
        this.compositeActive = true;
        const deviceId = canvas.getAttribute('data-device-id')!;
        const overlayId = canvas.getAttribute('data-overlay-id')!;
        this.startCompositing(deviceId, overlayId);
      }
    } else if (this.compositeActive && this.currentLayout.length < 2) {
      this.stopCompositing();
    }
  }

  ngOnDestroy(): void {
    this.resizeSubscription.unsubscribe();
    this.resizeObserver.unobserve(this.viewPane.nativeElement);
    this.stopCompositing();
  }

  private visibleDevicesChanged: Observable<DeviceGridItemUpdate[]> = this.displaysService.getDeviceVisibilities().pipe(map(deviceVisibilityInfos => deviceVisibilityInfos.map(info => {
    return {
      values: {
        ...this.createDeviceGridItem(info.id),
        visible: info.visible,
      },
      overwrites: ['visible'],
      source: this.visibleDeviceSource,
    };
  })));
  private displayInfoChanged: Observable<DeviceGridItemUpdate[]> = this.displaysService.getDisplayInfoChanged().pipe(map(displayInfo => {
    const updateValues = this.createDeviceGridItem(displayInfo.device_id);
    const overwrites = [];
    if (displayInfo.displays.length !== 0) {
      let w = 0, h = 0;
      displayInfo.displays.forEach((d: DisplayInfo) => {
        w += d.width;
        h = Math.max(d.height, h);
      });
      updateValues.display_width = w;
      updateValues.display_height = h;
      overwrites.push('display_width');
      overwrites.push('display_height');
      // Display service occasionally sends a dummy update - do not
      // overwrite display count in that case.
      if (displayInfo.displays[0].width !== 0) {
        updateValues.display_count = displayInfo.displays.length;
        overwrites.push('display_count');
      }
    }
    return [
      {
        values: updateValues,
        overwrites: overwrites,
        source: this.displayInfoSource,
      },
    ];
  }));
  private layoutUpdated: Observable<DeviceGridItemUpdate[]> = this.layoutUpdated$.pipe(map(newLayout => {
    return newLayout.map(layoutItem => {
      const updateValues = this.createDeviceGridItem(layoutItem.id);
      const overwrites = ['x', 'y', 'w', 'h'];
      updateValues.x = layoutItem.x;
      updateValues.y = layoutItem.y;
      updateValues.w = layoutItem.w;
      updateValues.h = layoutItem.h;
      return {
        values: updateValues,
        overwrites: overwrites,
        source: this.layoutUpdateSource,
      };
    });
  }));

  private adjustNewLayout(item: DeviceGridItem): DeviceGridItem {
    if (item.display_width === null || item.display_height === null)
      return item;

    if (
      item.display_width === this.freeScale ||
      item.display_height === this.freeScale
    )
      return item;

    const zoom = Math.min(
      (item.w - this.totalHorizontalSpacing(item)) / item.display_width,
      (item.h - this.totalVerticalSpacing) / item.display_height
    );

    item.w = Math.max(
      this.minPanelWidth,
      zoom * item.display_width + this.totalHorizontalSpacing(item)
    );
    item.h = Math.max(
      this.minPanelHeight,
      zoom * item.display_height + this.totalVerticalSpacing
    );
    item.zoom = zoom;

    return item;
  }

  private adjustDisplayInfo(item: DeviceGridItem): DeviceGridItem {
    if (item.display_width === null || item.display_height === null)
      return item;

    if (
      item.display_width === this.freeScale ||
      item.display_height === this.freeScale
    ) {
      item.w = this.defaultDisplayZoom * this.defaultDisplayWidth;
      item.h = this.defaultDisplayZoom * this.defaultDisplayHeight;
    } else {
      const zoom = item.zoom;

      item.w = Math.max(
        this.minPanelWidth,
        zoom * item.display_width + this.totalHorizontalSpacing(item)
      );
      item.h = Math.max(
        this.minPanelHeight,
        zoom * item.display_height + this.totalVerticalSpacing
      );
    }

    return item;
  }

  private placeNewItem(
    item: DeviceGridItem,
    layout: DeviceGridItem[]
  ): DeviceGridItem {
    const lastMaxY =
      layout.length !== 0 ? Math.max(...layout.map(obj => obj.y)) : 0;
    const lastRowLayout = layout.filter(obj => obj.y === lastMaxY);
    const lastMaxX =
      layout.length !== 0
        ? Math.max(...lastRowLayout.map(obj => obj.x))
        : -item.w;

    item.x = lastMaxX + item.w * 2 <= this.cols ? lastMaxX + item.w : 0;
    item.y = lastMaxX + item.h * 2 <= this.cols ? lastMaxY : lastMaxY + item.h;

    item.placed = true;

    asyncScheduler.schedule(() => {
      this.forceShowDevice(item.id);
    }, 10000);

    return item;
  }

  resultLayout: Observable<DeviceGridItem[]> = merge(this.visibleDevicesChanged, this.displayInfoChanged, this.layoutUpdated).pipe(scan((currentLayout: DeviceGridItem[], updateInfos: DeviceGridItemUpdate[]) => {
    const layoutById = new Map(currentLayout.map(item => [item.id, item]));
    updateInfos.forEach(updateItem => {
      const id = updateItem.values.id;
      let item = layoutById.has(id)
        ? layoutById.get(id)!
        : updateItem.values;
        updateItem.overwrites.forEach(prop => {
          // Ignore force show display message when display size is already set
          if ((prop === 'display_width' || prop === 'display_height')
              && item[prop] !== null && item[prop] !== this.freeScale
            && updateItem.values[prop] === this.freeScale) {
              return;
            }
            item[prop] = updateItem.values[prop]!;
        });
        switch (updateItem.source) {
          case this.visibleDeviceSource: {
            if (!item.placed && item.visible) {
              // When a new item is set visible
              item = this.placeNewItem(item, currentLayout);
            }
            break;
          }
          case this.layoutUpdateSource: {
            // When layout is changed
            item = this.adjustNewLayout(item);
            break;
          }
          case this.displayInfoSource: {
            // When device display info is changed
            item = this.adjustDisplayInfo(item);
            break;
          }
        }
        layoutById.set(id, item);
    });
    return Array.from(layoutById, ([, value]) => value);
  }, []), map(items => items.filter(item => item.visible)), tap(items => this.currentLayout = items));

  forceShowDevice(deviceId: string) {
    this.displaysService.onDeviceDisplayInfo({
      device_id: deviceId,
      rotation: 0,
      displays: [
        {
          display_id: '0',
          width: this.freeScale,
          height: this.freeScale,
        } as DisplayInfo,
      ],
    });
  }

  private readonly visibleDeviceSource = 'visible_device';
  private readonly displayInfoSource = 'display_info';
  private readonly layoutUpdateSource = 'layout_update';

  getOverlayId(deviceId: string): string | null {
    if (this.currentLayout.length < 2) return null;
    return deviceId === this.currentLayout[0].id ? this.currentLayout[1].id : null;
  }

  private startCompositing(deviceId: string, overlayId: string): void {
    console.log('[Composite] Starting:', deviceId, '+', overlayId);

    const canvas = this.document.querySelector(
      `canvas[data-device-id="${deviceId}"]`
    ) as HTMLCanvasElement;
    // CVD 1's own iframe (visible underneath the canvas, NOT hidden)
    const mainIframe = this.document.querySelector(
      `iframe[title="${deviceId}"]`
    ) as HTMLIFrameElement;
    // CVD 2's existing grid item iframe (no duplicate — reuse its WebRTC connection)
    const overlayIframe = this.document.querySelector(
      `iframe[title="${overlayId}"]`
    ) as HTMLIFrameElement;

    if (!canvas || !mainIframe || !overlayIframe) {
      console.error('[Composite] Missing elements:', {canvas: !!canvas, mainIframe: !!mainIframe, overlayIframe: !!overlayIframe});
      this.compositeActive = false;
      return;
    }

    this.compositeCheckInterval = setInterval(() => {
      try {
        const mainVideo = mainIframe.contentDocument?.querySelector('video') as HTMLVideoElement;
        const overlayVideo = overlayIframe.contentDocument?.querySelector('video') as HTMLVideoElement;

        console.log('[Composite] Polling...',
          'mainIframe.contentDocument:', !!mainIframe.contentDocument,
          'main video:', !!mainVideo, mainVideo?.videoWidth ?? 'N/A',
          'overlayIframe.contentDocument:', !!overlayIframe.contentDocument,
          'overlay video:', !!overlayVideo, overlayVideo?.videoWidth ?? 'N/A');

        if (mainVideo && overlayVideo && mainVideo.videoWidth > 0 && overlayVideo.videoWidth > 0) {
          clearInterval(this.compositeCheckInterval!);
          this.compositeCheckInterval = null;
          console.log('[Composite] Both videos ready — starting render loop',
            `main: ${mainVideo.videoWidth}x${mainVideo.videoHeight}`,
            `overlay: ${overlayVideo.videoWidth}x${overlayVideo.videoHeight}`);
          this.compositeOverlayVideo = overlayVideo;
          this.compositeOverlayIframe = overlayIframe;
          this.setupOverlayTouchHandling();
          this.runCompositeLoop(canvas, mainVideo, overlayVideo);
        }
      } catch (e) {
        console.error('[Composite] Cannot access iframe content:', e);
      }
    }, 1000);
  }

  private runCompositeLoop(
    canvas: HTMLCanvasElement,
    mainVideo: HTMLVideoElement,
    overlayVideo: HTMLVideoElement
  ): void {
    const ctx = canvas.getContext('2d')!;
    let lastW = 0;
    let lastH = 0;

    const render = () => {
      // Match canvas internal resolution to its CSS display size
      const displayRect = canvas.getBoundingClientRect();
      const w = Math.round(displayRect.width);
      const h = Math.round(displayRect.height);
      if (lastW !== w || lastH !== h) {
        lastW = w;
        lastH = h;
        canvas.width = w;
        canvas.height = h;
        console.log('[Composite] Canvas resized to display:', w, 'x', h);
      }

      // Clear entire canvas → transparent → iframe control panel shows through
      ctx.clearRect(0, 0, lastW, lastH);

      if (mainVideo.videoWidth > 0 && mainVideo.videoHeight > 0) {
        // Get video position within iframe (iframe-viewport-relative coords)
        const vr = mainVideo.getBoundingClientRect();

        // Draw main video at the exact position it occupies in the iframe
        ctx.drawImage(mainVideo, vr.left, vr.top, vr.width, vr.height);

        // Overlay: second CVD at 30% size, centered within the video area
        // Preserve overlay's native aspect ratio instead of stretching to main video's ratio
        if (overlayVideo.videoWidth > 0 && overlayVideo.videoHeight > 0) {
          const scale = 0.7;
          const overlayAspect = overlayVideo.videoWidth / overlayVideo.videoHeight;
          const maxW = vr.width * scale;
          const maxH = vr.height * scale;
          // Fit overlay within the max box while keeping its own aspect ratio
          let oW: number, oH: number;
          if (maxW / maxH > overlayAspect) {
            // max box is wider than overlay → constrain by heightq
            oH = maxH;
            oW = maxH * overlayAspect;
          } else {
            // max box is taller than overlay → constrain by width
            oW = maxW;
            oH = maxW / overlayAspect;
          }
          const oX = vr.left + (vr.width - oW) / 2;
          const oY = vr.top + (vr.height - oH) / 2;

          ctx.drawImage(overlayVideo, oX, oY, oW, oH);

          ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
          ctx.lineWidth = 2;
          ctx.strokeRect(oX, oY, oW, oH);

          // Update overlay touch target position to match drawn overlay
          // Canvas internal coords and CSS coords can differ if canvas element
          // is offset within its container (e.g. inline baseline gap)
          const touchTarget = canvas.parentElement?.querySelector('.overlay-touch-target') as HTMLElement;
          if (touchTarget) {
            const canvasRect = canvas.getBoundingClientRect();
            const containerRect = canvas.parentElement!.getBoundingClientRect();
            const deltaX = canvasRect.left - containerRect.left;
            const deltaY = canvasRect.top - containerRect.top;
            touchTarget.style.left = `${oX + deltaX}px`;
            touchTarget.style.top = `${oY + deltaY}px`;
            touchTarget.style.width = `${oW}px`;
            touchTarget.style.height = `${oH}px`;

            // One-time debug log for overlay layout
            if (!this.compositeDebugLogged) {
              this.compositeDebugLogged = true;
              console.log('[Render Debug] Canvas internal:', { w: canvas.width, h: canvas.height });
              console.log('[Render Debug] Canvas CSS rect:', canvasRect);
              console.log('[Render Debug] Container rect:', containerRect);
              console.log('[Render Debug] Delta:', { deltaX, deltaY });
              console.log('[Render Debug] Main video rect (vr):', { left: vr.left, top: vr.top, width: vr.width, height: vr.height });
              console.log('[Render Debug] Overlay drawn at canvas coords:', { oX, oY, oW, oH });
              console.log('[Render Debug] Touch target CSS:', {
                left: touchTarget.style.left,
                top: touchTarget.style.top,
                width: touchTarget.style.width,
                height: touchTarget.style.height,
              });
              console.log('[Render Debug] Canvas scale factor:', {
                scaleX: canvasRect.width / canvas.width,
                scaleY: canvasRect.height / canvas.height,
              });
              console.log('[Render Debug] Overlay visual CSS position:', {
                visualLeft: oX * (canvasRect.width / canvas.width),
                visualTop: oY * (canvasRect.height / canvas.height),
                visualWidth: oW * (canvasRect.width / canvas.width),
                visualHeight: oH * (canvasRect.height / canvas.height),
              });
            }
          }
        }
      }

      this.compositeAnimationId = requestAnimationFrame(render);
    };

    render();
  }

  private setupOverlayTouchHandling(): void {
    const touchTarget = this.document.querySelector('.overlay-touch-target') as HTMLElement;
    if (!touchTarget) {
      console.error('[Composite] Touch target not found');
      return;
    }

    const handler = (e: PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.type === 'pointerdown') {
        touchTarget.setPointerCapture(e.pointerId);
      }

      const video = this.compositeOverlayVideo;
      const iframe = this.compositeOverlayIframe;
      if (!video || !iframe?.contentWindow) return;

      // Convert touch position to relative coords within overlay (0..1)
      const relX = e.offsetX / touchTarget.offsetWidth;
      const relY = e.offsetY / touchTarget.offsetHeight;

      // Map to CVD 2's video element coordinates
      const videoRect = video.getBoundingClientRect();
      const clientX = videoRect.left + relX * video.offsetWidth;
      const clientY = videoRect.top + relY * video.offsetHeight;

      if (e.type === 'pointerdown') {
        console.log('[Touch Debug] === POINTER DOWN ===');
        console.log('[Touch Debug] Touch target:', {
          offsetWidth: touchTarget.offsetWidth,
          offsetHeight: touchTarget.offsetHeight,
          cssWidth: touchTarget.style.width,
          cssHeight: touchTarget.style.height,
          rect: touchTarget.getBoundingClientRect(),
        });
        console.log('[Touch Debug] Event offset:', { offsetX: e.offsetX, offsetY: e.offsetY });
        console.log('[Touch Debug] Relative:', { relX, relY });
        console.log('[Touch Debug] Video element:', {
          offsetWidth: video.offsetWidth,
          offsetHeight: video.offsetHeight,
          videoWidth: video.videoWidth,
          videoHeight: video.videoHeight,
          aspectRatio_element: video.offsetWidth / video.offsetHeight,
          aspectRatio_content: video.videoWidth / video.videoHeight,
          rect: videoRect,
        });
        console.log('[Touch Debug] Synthetic clientX/Y:', { clientX, clientY });
        console.log('[Touch Debug] Expected offsetX/Y in iframe:', {
          expectedOffsetX: clientX - videoRect.left,
          expectedOffsetY: clientY - videoRect.top,
        });
        const scaling = video.videoWidth / video.offsetWidth;
        console.log('[Touch Debug] touch.js scaling:', scaling);
        console.log('[Touch Debug] Final device coords (predicted):', {
          x: Math.trunc((clientX - videoRect.left) * scaling),
          y: Math.trunc((clientY - videoRect.top) * scaling),
          expected_x: Math.trunc(relX * video.videoWidth),
          expected_y: Math.trunc(relY * video.videoHeight),
        });
      }

      // Use iframe's PointerEvent constructor for cross-frame compatibility
      const iframeWindow = iframe.contentWindow as any;
      const syntheticEvent = new iframeWindow.PointerEvent(e.type, {
        clientX,
        clientY,
        pointerId: e.pointerId,
        pointerType: e.pointerType || 'touch',
        isPrimary: e.isPrimary,
        bubbles: true,
        cancelable: true,
      });

      // Log what touch.js actually receives
      if (e.type === 'pointerdown') {
        console.log('[Touch Debug] Synthetic event created:', {
          clientX: syntheticEvent.clientX,
          clientY: syntheticEvent.clientY,
          offsetX: syntheticEvent.offsetX,
          offsetY: syntheticEvent.offsetY,
        });
      }

      video.dispatchEvent(syntheticEvent);

      // Check offsetX/offsetY after dispatch (may be recomputed)
      if (e.type === 'pointerdown') {
        console.log('[Touch Debug] After dispatch offsetX/Y:', {
          offsetX: syntheticEvent.offsetX,
          offsetY: syntheticEvent.offsetY,
        });
      }
    };

    touchTarget.addEventListener('pointerdown', handler);
    touchTarget.addEventListener('pointermove', handler);
    touchTarget.addEventListener('pointerup', handler);
    touchTarget.addEventListener('pointercancel', handler);
    console.log('[Composite] Overlay touch handling ready');
  }

  private stopCompositing(): void {
    if (this.compositeAnimationId !== null) {
      cancelAnimationFrame(this.compositeAnimationId);
      this.compositeAnimationId = null;
    }
    if (this.compositeCheckInterval !== null) {
      clearInterval(this.compositeCheckInterval);
      this.compositeCheckInterval = null;
    }
    this.compositeOverlayVideo = null;
    this.compositeOverlayIframe = null;
    this.compositeActive = false;
    console.log('[Composite] Stopped');
  }

  private createDeviceGridItem(id: string): DeviceGridItem {
    return {
      id: id,
      x: 0,
      y: 0,
      w: this.minPanelWidth,
      h: this.minPanelHeight,
      display_width: null,
      display_height: null,
      display_count: 0,
      zoom: this.defaultDisplayZoom,
      visible: false,
      placed: false,
    };
  }
}
