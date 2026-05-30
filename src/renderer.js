/**
 * src/renderer.js
 * 
 * High-performance 2D WebGL renderer for E. coli metabolic network using PixiJS (v8).
 * Draws Escher map topology using cubic Bezier curves, animates dynamic
 * metabolic flux particles, handles pulsation, and Google Maps-style navigation.
 */

import { Application, Container, Graphics, Text, Rectangle } from 'pixi.js';

// Helper to measure text width and height synchronously using HTML5 Canvas 2D
function measureTextSize(text, fontSize, fontFamily) {
  if (!measureTextSize.canvas) {
    measureTextSize.canvas = document.createElement('canvas');
    measureTextSize.context = measureTextSize.canvas.getContext('2d');
  }
  const ctx = measureTextSize.context;
  ctx.font = `500 ${fontSize}px ${fontFamily}`;
  const metrics = ctx.measureText(text);
  const width = metrics.width;
  // Approximate height based on font size or bounding box if available
  const height = (metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent) || (fontSize * 0.9);
  return { width, height };
}

export class PixiRenderer {
  constructor(canvasElement, onSelectMetabolite, onSelectReaction) {
    this.canvas = canvasElement;
    this.onSelectMetabolite = onSelectMetabolite;
    this.onSelectReaction = onSelectReaction;
    
    this.app = null;
    this.viewport = null;
    
    // Viewport zoom & pan state
    this.zoom = 1.0;
    this.isDragging = false;
    this.dragStart = { x: 0, y: 0 };
    this.viewportStart = { x: 0, y: 0 };
    
    // Animation/camera targets for smooth lerp transitions
    this.targetZoom = 1.0;
    this.targetPosition = { x: 0, y: 0 };
    this.isCameraAnimating = false;

    // Local registers
    this.nodes = {};      // nodeId -> parsed node
    this.metabNodes = []; // list of metabolite nodes for rendering
    this.reactions = [];  // list of reactions and curves
    this.labels = [];     // list of labels
    
    // Pixi dynamic graphics
    this.staticMapGraphics = null;
    this.particleGraphics = null;
    this.metaboliteGraphics = null;
    this.textContainer = null;
    this.badgeContainer = null;

    // Hover state
    this.hoveredNode = null;
    this.hoveredReaction = null;
    this.selectedNodeId = null;
    this.selectedReactionId = null;

    // Label font settings
    this.baseFontSize = 30;
    this.activeNamespace = 'bigg';
    this.getLabelText = null;
    this.lastSimReactions = null;
  }

  /**
   * Initialize PixiJS application and draw initial map.
   */
  async init(mapData) {
    // 1. Create PixiJS App (v8 style)
    this.app = new Application();
    await this.app.init({
      canvas: this.canvas,
      resizeTo: window,
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
      backgroundColor: 0x08080c,
    });

    // 2. Setup Viewport Container
    this.viewport = new Container();
    this.app.stage.addChild(this.viewport);

    // 3. Create layers inside the viewport
    this.staticMapGraphics = new Graphics();
    this.viewport.addChild(this.staticMapGraphics);

    this.particleGraphics = new Graphics();
    this.viewport.addChild(this.particleGraphics);

    this.metaboliteGraphics = new Graphics();
    this.viewport.addChild(this.metaboliteGraphics);

    this.badgeContainer = new Container();
    this.viewport.addChild(this.badgeContainer);

    this.textContainer = new Container();
    this.viewport.addChild(this.textContainer);

    // 4. Parse Escher data
    this.parseEscherMap(mapData);

    // 5. Setup Viewport Fit (Initial Centering)
    this.fitMapToScreen();

    // 6. Setup Interactive Listeners for Zoom/Pan and click selection
    this.setupInteractivity();

    // 7. Start PixiJS Tick Loop
    this.app.ticker.add((ticker) => {
      this.updateCamera(ticker.deltaTime);
    });
  }

  /**
   * Parses nodes, reactions, and text labels from Escher JSON.
   */
  parseEscherMap(mapData) {
    const data = mapData[1];

    // 1. Parse Nodes
    for (const [nodeId, node] of Object.entries(data.nodes)) {
      this.nodes[nodeId] = {
        id: nodeId,
        biggId: node.bigg_id,
        name: node.name,
        type: node.node_type,
        x: node.x,
        y: node.y,
        labelX: node.label_x,
        labelY: node.label_y
      };

      if (node.node_type === 'metabolite') {
        this.metabNodes.push(this.nodes[nodeId]);
      }
    }

    // 2. Parse Reactions and build curves
    for (const [rxnId, rxn] of Object.entries(data.reactions)) {
      const reaction = {
        id: rxnId,
        biggId: rxn.bigg_id,
        name: rxn.name,
        reversibility: rxn.reversibility,
        labelX: rxn.label_x,
        labelY: rxn.label_y,
        segments: []
      };

      // Extract Bezier curves from segments
      for (const [segId, seg] of Object.entries(rxn.segments)) {
        const fromNode = this.nodes[seg.from_node_id];
        const toNode = this.nodes[seg.to_node_id];

        if (fromNode && toNode) {
          const segment = {
            id: segId,
            from: fromNode,
            to: toNode,
            b1: seg.b1,
            b2: seg.b2,
            points: [] // Pre-calculated points for linear interpolation
          };

          // Precompute points along Bezier curves for particle flow optimization
          const P0 = { x: fromNode.x, y: fromNode.y };
          const P3 = { x: toNode.x, y: toNode.y };
          const P1 = seg.b1 ? { x: seg.b1.x, y: seg.b1.y } : null;
          const P2 = seg.b2 ? { x: seg.b2.x, y: seg.b2.y } : null;

          const numPoints = 20;
          for (let i = 0; i < numPoints; i++) {
            const t = i / (numPoints - 1);
            let pt;
            if (P1 && P2) {
              // Cubic Bezier
              const c = 1 - t;
              pt = {
                x: c * c * c * P0.x + 3 * c * c * t * P1.x + 3 * c * t * t * P2.x + t * t * t * P3.x,
                y: c * c * c * P0.y + 3 * c * c * t * P1.y + 3 * c * t * t * P2.y + t * t * t * P3.y
              };
            } else {
              // Straight Line
              pt = {
                x: P0.x + t * (P3.x - P0.x),
                y: P0.y + t * (P3.y - P0.y)
              };
            }
            segment.points.push(pt);
          }

          reaction.segments.push(segment);
        }
      }

      this.reactions.push(reaction);
    }

    // 3. Draw static map background grid lines and reaction lines (pre-rendered once)
    this.drawStaticMap();
    this.createStaticTexts();
    this.createReactionBadges();
  }

  /**
   * Pre-calculates and draws static elements (grid and reaction paths) to maximize WebGL performance.
   */
  drawStaticMap() {
    const g = this.staticMapGraphics;
    g.clear();

    // 1. Draw coordinate grid lines
    const gridSpacing = 400;
    for (let x = -500; x < 6500; x += gridSpacing) {
      g.moveTo(x, -500);
      g.lineTo(x, 5500);
    }
    for (let y = -500; y < 5500; y += gridSpacing) {
      g.moveTo(-500, y);
      g.lineTo(6500, y);
    }
    g.stroke({ width: 1.5, color: 0x6366f1, alpha: 0.03 });

    // 2. Draw reaction paths (smooth Bezier curves)
    this.reactions.forEach(rxn => {
      rxn.segments.forEach(seg => {
        const pts = seg.points;
        g.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) {
          g.lineTo(pts[i].x, pts[i].y);
        }
      });
    });
    g.stroke({ width: 2.5, color: 0x3f3f46, alpha: 0.6 });
  }

  /**
   * Creates static text nodes in Pixi for metabolites and reactions.
   */
  createStaticTexts() {
    // Destroy existing text children to prevent memory leaks in PixiJS
    if (this.textContainer) {
      this.textContainer.children.forEach(child => {
        if (child.destroy) {
          child.destroy();
        }
      });
      this.textContainer.removeChildren();
    }

    // Draw Metabolite Name Labels
    this.metabNodes.forEach(node => {
      if (!node.labelX || !node.labelY) return;

      const style = {
        fontFamily: 'Outfit, sans-serif',
        fontSize: this.baseFontSize,
        fill: 0x8a99ad,
        fontWeight: 'bold',
        align: 'left'
      };

      const labelText = (this.activeNamespace === 'common') 
        ? node.name 
        : (this.getLabelText ? this.getLabelText(node.biggId, this.activeNamespace) : node.name);
      
      const text = new Text({ text: labelText, style });
      text.x = node.labelX;
      text.y = node.labelY - 5;
      text.anchor.set(0, 0.5); // align left, middle
      this.textContainer.addChild(text);
      node.textElement = text;
    });

    // Draw Reaction Labels
    this.reactions.forEach(rxn => {
      if (!rxn.labelX || !rxn.labelY) return;

      const style = {
        fontFamily: 'Inter, sans-serif',
        fontSize: Math.max(6, Math.round(this.baseFontSize * 10 / 12)),
        fill: 0x4f46e5,
        fontWeight: '500',
        align: 'center'
      };

      const text = new Text({ text: rxn.biggId, style });
      text.x = rxn.labelX;
      text.y = rxn.labelY;
      text.anchor.set(0.5, 0.5);
      this.textContainer.addChild(text);
      rxn.textElement = text;
    });
  }

  /**
   * Updates the base font size for map labels and redraws the texts.
   */
  updateLabelFontSize(newSize) {
    this.baseFontSize = newSize;
    this.createStaticTexts();
    this.createReactionBadges();
  }

  /**
   * Updates the active namespace and redraws the texts.
   */
  updateLabelNamespace(namespace) {
    this.activeNamespace = namespace;
    this.createStaticTexts();
  }

  /**
   * Creates clickable badges representing enzymes/reactions.
   */
  createReactionBadges() {
    this.badgeContainer.removeChildren();
    
    this.reactions.forEach(rxn => {
      if (!rxn.labelX || !rxn.labelY) return;

      // Calculate width and height dynamically based on the text bounding box
      const labelFontSize = Math.max(6, Math.round(this.baseFontSize * 10 / 12));
      const size = measureTextSize(rxn.biggId, labelFontSize, 'Inter, sans-serif');

      // Add padding around the text (proportional to font size)
      const paddingX = Math.round(labelFontSize * 0.75);
      const paddingY = Math.round(labelFontSize * 0.5);
      const width = Math.max(20, size.width + paddingX);
      const height = Math.max(10, size.height + paddingY);

      rxn.badgeWidth = width;
      rxn.badgeHeight = height;

      const bg = new Graphics();
      bg.roundRect(-width / 2, -height / 2, width, height, 4);
      bg.fill({ color: 0x0f172a, alpha: 0.85 });
      bg.stroke({ color: 0x6366f1, width: 1.0, alpha: 0.4 });
      
      bg.x = rxn.labelX;
      bg.y = rxn.labelY;
      bg.interactive = true;
      bg.cursor = 'pointer';

      // Selection indicator
      bg.on('pointerover', () => {
        this.hoveredReaction = rxn;
        this.updateReactionBadgeHighlight();
      });

      bg.on('pointerout', () => {
        this.hoveredReaction = null;
        this.updateReactionBadgeHighlight();
      });

      bg.on('pointerdown', (e) => {
        e.stopPropagation();
        this.selectReaction(rxn.id);
        this.onSelectReaction(rxn);
      });

      this.badgeContainer.addChild(bg);
      rxn.badgeElement = bg;
    });
  }

  /**
   * Selects a metabolite and highlights it.
   */
  selectMetabolite(nodeId) {
    this.selectedNodeId = nodeId;
    this.selectedReactionId = null;
    this.updateReactionBadgeHighlight();
  }

  /**
   * Selects a reaction and highlights it.
   */
  selectReaction(rxnId) {
    this.selectedReactionId = rxnId;
    this.selectedNodeId = null;
    this.updateReactionBadgeHighlight();
  }

  /**
   * Clear active selection.
   */
  clearSelection() {
    this.selectedNodeId = null;
    this.selectedReactionId = null;
    this.updateReactionBadgeHighlight();
  }



  /**
   * Redraw reaction badges to update highlights.
   */
  updateReactionBadgeHighlight() {
    this.reactions.forEach(rxn => {
      if (rxn.badgeElement) {
        const width = rxn.badgeWidth || 50;
        const height = rxn.badgeHeight || 18;
        const bg = rxn.badgeElement;
        
        let strokeColor = 0x6366f1; // default indigo
        let strokeWidth = 1.0;
        let strokeAlpha = 0.4;
        let fillColor = 0x0f172a;
        let fillAlpha = 0.85;

        // Check if modified compared to defaults in simulation
        if (this.lastSimReactions) {
          const simRxn = this.lastSimReactions[rxn.biggId];
          if (simRxn && simRxn.defaultVmax !== undefined && simRxn.defaultKm !== undefined) {
            const ratio = simRxn.vMax / simRxn.km;
            const defaultRatio = simRxn.defaultVmax / simRxn.defaultKm;
            const diff = ratio - defaultRatio;

            if (diff > 1e-4) {
              strokeColor = 0x10b981; // green (activation/upregulation)
              strokeWidth = 2.0;
              strokeAlpha = 0.9;
            } else if (diff < -1e-4) {
              strokeColor = 0xef4444; // red (inhibition/downregulation)
              strokeWidth = 2.0;
              strokeAlpha = 0.9;
            }
          }
        }

        if (this.selectedReactionId === rxn.id) {
          fillColor = 0x1e1b4b;
          fillAlpha = 0.95;
          strokeWidth = 2.5;
          if (strokeColor === 0x6366f1) {
            strokeColor = 0x818cf8;
          }
          strokeAlpha = 1.0;
        } else if (this.hoveredReaction && this.hoveredReaction.id === rxn.id) {
          fillColor = 0x1e293b;
          fillAlpha = 0.95;
          strokeWidth = 2.0;
          if (strokeColor === 0x6366f1) {
            strokeColor = 0x818cf8;
          }
          strokeAlpha = 1.0;
        }

        bg.clear();
        bg.roundRect(-width / 2, -height / 2, width, height, 4);
        bg.fill({ color: fillColor, alpha: fillAlpha });
        bg.stroke({ color: strokeColor, width: strokeWidth, alpha: strokeAlpha });
      }
    });
  }

  /**
   * Fits the entire metabolic map centered inside the viewport canvas.
   */
  fitMapToScreen() {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    
    this.metabNodes.forEach(node => {
      if (node.x < minX) minX = node.x;
      if (node.x > maxX) maxX = node.x;
      if (node.y < minY) minY = node.y;
      if (node.y > maxY) maxY = node.y;
    });

    if (minX === Infinity) return;

    const mapW = maxX - minX;
    const mapH = maxY - minY;
    const padding = 150;

    const scaleX = (this.app.renderer.width - padding) / mapW;
    const scaleY = (this.app.renderer.height - padding) / mapH;
    
    // Choose the limiting scale factor
    this.zoom = Math.min(scaleX, scaleY);
    this.zoom = Math.max(0.12, Math.min(1.5, this.zoom)); // clamp initial zoom

    const mapCenterX = (minX + maxX) / 2;
    const mapCenterY = (minY + maxY) / 2;

    this.viewport.x = this.app.renderer.width / 2 - mapCenterX * this.zoom;
    this.viewport.y = this.app.renderer.height / 2 - mapCenterY * this.zoom;
    this.viewport.scale.set(this.zoom);

    this.targetZoom = this.zoom;
    this.targetPosition.x = this.viewport.x;
    this.targetPosition.y = this.viewport.y;
  }

  /**
   * Smoothly pans and zooms the camera to focus on a particular pathway bounding box.
   */
  focusOnPathway(pathwayMetabIds) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    let count = 0;

    this.metabNodes.forEach(node => {
      if (pathwayMetabIds.has(node.biggId)) {
        if (node.x < minX) minX = node.x;
        if (node.x > maxX) maxX = node.x;
        if (node.y < minY) minY = node.y;
        if (node.y > maxY) maxY = node.y;
        count++;
      }
    });

    if (count === 0) {
      // Fallback to full fit
      this.fitMapToScreen();
      return;
    }

    const padding = 200;
    const boxW = Math.max(300, maxX - minX);
    const boxH = Math.max(300, maxY - minY);

    const scaleX = (this.app.renderer.width - padding) / boxW;
    const scaleY = (this.app.renderer.height - padding) / boxH;
    
    this.targetZoom = Math.max(0.15, Math.min(1.2, Math.min(scaleX, scaleY)));

    const boxCenterX = (minX + maxX) / 2;
    const boxCenterY = (minY + maxY) / 2;

    this.targetPosition.x = this.app.renderer.width / 2 - boxCenterX * this.targetZoom;
    // Offset slightly to the left to compensate for the right details panel
    this.targetPosition.x -= 100;
    this.targetPosition.y = this.app.renderer.height / 2 - boxCenterY * this.targetZoom;

    this.isCameraAnimating = true;
  }

  /**
   * Updates camera animation using linear interpolation (lerp).
   */
  updateCamera(deltaTime) {
    if (!this.isCameraAnimating) return;

    const lerpSpeed = 0.1 * deltaTime; // Adjust speed of transitions

    this.zoom += (this.targetZoom - this.zoom) * lerpSpeed;
    this.viewport.scale.set(this.zoom);

    this.viewport.x += (this.targetPosition.x - this.viewport.x) * lerpSpeed;
    this.viewport.y += (this.targetPosition.y - this.viewport.y) * lerpSpeed;

    // Check if target is close enough to stop animation
    const posDist = Math.hypot(this.targetPosition.x - this.viewport.x, this.targetPosition.y - this.viewport.y);
    const zoomDist = Math.abs(this.targetZoom - this.zoom);

    if (posDist < 0.5 && zoomDist < 0.005) {
      this.zoom = this.targetZoom;
      this.viewport.x = this.targetPosition.x;
      this.viewport.y = this.targetPosition.y;
      this.viewport.scale.set(this.zoom);
      this.isCameraAnimating = false;
    }
  }

  /**
   * Binds pointer and wheel events to implement panning, zooming, and hit testing.
   */
  setupInteractivity() {
    const el = this.canvas;

    // Drag-to-pan implementation
    el.addEventListener('pointerdown', (e) => {
      // Check if we clicked on a metabolite node (hit test)
      const canvasX = e.clientX;
      const canvasY = e.clientY;
      const node = this.hitTestMetabolite(canvasX, canvasY);

      if (node) {
        this.selectMetabolite(node.id);
        this.onSelectMetabolite(node);
        return;
      }

      // If we clicked background, start drag panning
      this.isDragging = true;
      this.isCameraAnimating = false; // Interrupt any camera fly-to
      this.dragStart.x = canvasX;
      this.dragStart.y = canvasY;
      this.viewportStart.x = this.viewport.x;
      this.viewportStart.y = this.viewport.y;
      el.setPointerCapture(e.pointerId);
    });

    el.addEventListener('pointermove', (e) => {
      const canvasX = e.clientX;
      const canvasY = e.clientY;

      if (this.isDragging) {
        const dx = canvasX - this.dragStart.x;
        const dy = canvasY - this.dragStart.y;
        this.viewport.x = this.viewportStart.x + dx;
        this.viewport.y = this.viewportStart.y + dy;
        
        // Update targets so camera transitions don't snap back on subsequent triggers
        this.targetPosition.x = this.viewport.x;
        this.targetPosition.y = this.viewport.y;
        return;
      }

      // Otherwise, handle mouse hover tooltips
      const node = this.hitTestMetabolite(canvasX, canvasY);
      if (node !== this.hoveredNode) {
        this.hoveredNode = node;
        el.style.cursor = node ? 'pointer' : 'default';
        
        // Custom event to main controller for tooltips
        const event = new CustomEvent('metabolite-hover', { detail: node });
        el.dispatchEvent(event);
      }
    });

    const endDrag = (e) => {
      if (this.isDragging) {
        this.isDragging = false;
        try {
          el.releasePointerCapture(e.pointerId);
        } catch (err) {}
      }
    };

    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', endDrag);
    el.addEventListener('pointerupoutside', endDrag);

    // Zoom-to-cursor scroll implementation
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.isCameraAnimating = false; // cancel animation

      const zoomSpeed = 0.001;
      const zoomFactor = 1 - e.deltaY * zoomSpeed;

      const rect = el.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const oldZoom = this.zoom;
      let newZoom = this.zoom * zoomFactor;
      
      // Clamp zoom between 0.08x (far) and 4.0x (close)
      newZoom = Math.max(0.08, Math.min(4.0, newZoom));

      // Coordinate shift to keep zoom centered on mouse cursor
      const nextX = mouseX - (mouseX - this.viewport.x) * (newZoom / oldZoom);
      const nextY = mouseY - (mouseY - this.viewport.y) * (newZoom / oldZoom);

      this.zoom = newZoom;
      this.viewport.scale.set(this.zoom);
      this.viewport.x = nextX;
      this.viewport.y = nextY;

      this.targetZoom = this.zoom;
      this.targetPosition.x = this.viewport.x;
      this.targetPosition.y = this.viewport.y;
    }, { passive: false });

    // Click on canvas background to deselect
    el.addEventListener('click', (e) => {
      const node = this.hitTestMetabolite(e.clientX, e.clientY);
      if (!node && !this.hoveredReaction) {
        this.clearSelection();
        this.onSelectMetabolite(null);
      }
    });
  }

  /**
   * Helper to perform distance-based hit testing for circular metabolite nodes.
   */
  hitTestMetabolite(canvasX, canvasY) {
    const rect = this.canvas.getBoundingClientRect();
    const x = canvasX - rect.left;
    const y = canvasY - rect.top;

    // Convert mouse coordinates to viewport coordinates
    const viewX = (x - this.viewport.x) / this.zoom;
    const viewY = (y - this.viewport.y) / this.zoom;

    // Radius check
    for (const node of this.metabNodes) {
      const dist = Math.hypot(viewX - node.x, viewY - node.y);
      const radius = node.renderedRadius || 18.0;
      if (dist <= radius + 5) { // 5px buffer for fat fingers/easy clicking
        return node;
      }
    }
    return null;
  }

  /**
   * Main rendering update loop called by the controller.
   * Updates metabolites pulsation and draws animated flow particles.
   */
  renderUpdate(simMetabolites, simReactions, animationFrameCount) {
    if (!this.viewport) return;

    this.lastSimReactions = simReactions;
    this.updateReactionBadgeHighlight();

    // Update camera layout values dynamically to center focused highlights if needed
    // 1. Draw Metabolites Pulsation
    const mg = this.metaboliteGraphics;
    mg.clear();

    this.metabNodes.forEach(node => {
      const simMetab = simMetabolites[node.biggId];
      if (!simMetab) return;

      const concentration = simMetab.concentration;

      // Radius changes dynamically: base + scale based on square root of concentration
      const baseRadius = node.biggId.includes('glc__D') ? 22 : 15;
      const scaleFactor = 0.5 + Math.sqrt(concentration) * 0.6;
      const radius = baseRadius * Math.max(0.4, Math.min(3.5, scaleFactor));
      node.renderedRadius = radius;

      // Choose styling based on type and status
      let color = 0xf472b6; // pink
      let glowColor = 0xdb2777;
      let alpha = 0.9;

      if (simMetab.type === 'substrate') {
        color = 0x60a5fa; // blue
        glowColor = 0x2563eb;
      } else if (simMetab.type === 'cofactor') {
        color = 0x34d399; // mint green
        glowColor = 0x059669;
        alpha = 0.55; // cofactors are transparent to avoid layout clutter
      }

      // Draw highlighted ring if selected
      if (this.selectedNodeId === node.id) {
        mg.circle(node.x, node.y, radius + 4).stroke({ width: 3.5, color: 0x818cf8, alpha: 1.0 });
      } else if (this.hoveredNode && this.hoveredNode.id === node.id) {
        mg.circle(node.x, node.y, radius + 3).stroke({ width: 2.0, color: 0xffffff, alpha: 0.8 });
      }

      // Draw metabolite node fill
      mg.circle(node.x, node.y, radius).fill({ color, alpha });

      // Draw thin inner white rim
      mg.circle(node.x, node.y, radius - 1).stroke({ width: 1.0, color: 0xffffff, alpha: 0.25 });
    });

    // 2. Draw Moving Flux Particles
    const pg = this.particleGraphics;
    pg.clear();

    this.reactions.forEach(rxn => {
      const simRxn = simReactions[rxn.biggId];
      if (!simRxn) return;

      const flux = simRxn.flux;
      const absFlux = Math.abs(flux);

      // No flow for inactive reactions
      if (absFlux < 0.02) return;

      // Color coding: blue for substrate uptake, green for cofactors, magenta/indigo for pathways
      let color = 0x818cf8; // indigo
      if (rxn.biggId === 'GLCpts') {
        color = 0x60a5fa; // bright blue for glucose uptake
      } else if (rxn.biggId === 'BIOMASS_Ecoli_core_w_GAM') {
        color = 0xf472b6; // pink for biomass synthesis
      } else if (rxn.biggId.includes('ATPM')) {
        color = 0x34d399; // green for ATP coupling maintenance
      }

      // Speed & density proportional to flux magnitude
      const speedFactor = 0.015 * absFlux;
      const numParticles = 2; // Fixed particles per segment

      rxn.segments.forEach(seg => {
        const pts = seg.points;
        const N = pts.length;

        for (let i = 0; i < numParticles; i++) {
          // Space out the particles along the segment
          const offset = i / numParticles;
          
          let t;
          if (flux > 0) {
            // Forward flow: start at 0, go to 1
            t = (animationFrameCount * speedFactor + offset) % 1.0;
          } else {
            // Reversible flow (backward): start at 1, go to 0
            t = 1.0 - ((animationFrameCount * speedFactor + offset) % 1.0);
          }

          // Linearly interpolate coordinates from precalculated path points
          const index = t * (N - 1);
          const i0 = Math.floor(index);
          const i1 = Math.min(N - 1, i0 + 1);
          const f = index - i0;

          const px = pts[i0].x + f * (pts[i1].x - pts[i0].x);
          const py = pts[i0].y + f * (pts[i1].y - pts[i0].y);

          // Render glowing dot
          const pRadius = 2.0 + Math.min(2.5, absFlux * 0.15);
          pg.circle(px, py, pRadius).fill({ color, alpha: 0.8 });
        }
      });
    });


  }

  /**
   * Destroys Pixi Application safely.
   */
  destroy() {
    if (this.app) {
      this.app.destroy(true, { children: true, texture: true });
    }
  }
}
