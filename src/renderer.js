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
    
    // Pinch to zoom state
    this.activePointers = new Map();
    this.isPinching = false;
    this.pinchStartDist = 0;
    this.pinchStartCenter = { x: 0, y: 0 };
    this.pinchStartZoom = 1.0;
    this.pinchStartViewport = { x: 0, y: 0 };

    // Animation/camera targets for smooth lerp transitions
    this.targetZoom = 1.0;
    this.targetPosition = { x: 0, y: 0 };
    this.isCameraAnimating = false;
    this.cameraLerpSpeed = 0.1;

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
    this.mapWarnings = [];
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

    // 5. Setup Viewport Fit (Initial Centering & Startup Zoom Animation)
    this.fitMapToScreen(true, true);

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
    this.mapWarnings = [];

    // 1. Parse Nodes
    for (const [nodeId, node] of Object.entries(data.nodes)) {
      const parsedNode = {
        id: nodeId,
        biggId: node.bigg_id,
        name: node.name,
        type: node.node_type,
        x: node.x,
        y: node.y,
        labelX: node.label_x,
        labelY: node.label_y
      };

      this.nodes[nodeId] = parsedNode;

      if (node.node_type === 'metabolite') {
        // Check if label coordinates are missing or far away
        const hasLabelX = node.label_x !== undefined && node.label_x !== null;
        const hasLabelY = node.label_y !== undefined && node.label_y !== null;
        if (!hasLabelX || !hasLabelY) {
          const warningMsg = `Metabolite "${node.name}" (${node.bigg_id}) is missing label coordinates in JSON.`;
          console.warn(`[Map Warning] ${warningMsg}`);
          this.mapWarnings.push({
            id: nodeId,
            biggId: node.bigg_id,
            name: node.name,
            type: 'missing',
            message: warningMsg
          });
        }

        // Determine preferred angle
        let preferredAngle = 0; // default to right (0 radians)
        if (hasLabelX && hasLabelY) {
          preferredAngle = Math.atan2(node.label_y - node.y, node.label_x - node.x);
        }
        parsedNode.preferredAngle = preferredAngle;

        this.metabNodes.push(parsedNode);
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

    // 3. Spatial precomputation & Draw static map background grid lines and reaction lines (pre-rendered once)
    this.precomputeSpatialLayout();
    this.drawStaticMap();
    this.createStaticTexts();
    this.createReactionBadges();
  }

  /**
   * Precomputes spatial coordinates, distances, and exit angles to enable high-speed runtime overlap checks.
   */
  precomputeSpatialLayout() {
    // 1. Precompute nearby nodes for label-label overlap checks
    const distanceThreshold = 250;
    this.metabNodes.forEach(node => {
      node.nearbyNodes = [];
      this.metabNodes.forEach(other => {
        if (other.id === node.id) return;
        const dist = Math.hypot(other.x - node.x, other.y - node.y);
        if (dist < distanceThreshold) {
          node.nearbyNodes.push(other);
        }
      });
    });

    // 2. Precompute restricted sectors (angles) for reaction lines and other nodes
    this.metabNodes.forEach(node => {
      node.restrictedAngles = [];

      // A. Incident reaction segments
      this.reactions.forEach(rxn => {
        rxn.segments.forEach(seg => {
          let exitAngle = null;

          if (seg.from.id === node.id && seg.points.length > 1) {
            const pt = seg.points[1];
            exitAngle = Math.atan2(pt.y - node.y, pt.x - node.x);
          } else if (seg.to.id === node.id && seg.points.length > 1) {
            const pt = seg.points[seg.points.length - 2];
            exitAngle = Math.atan2(pt.y - node.y, pt.x - node.x);
          }

          if (exitAngle !== null) {
            node.restrictedAngles.push({
              angle: exitAngle,
              weight: 1.2,
              type: 'incident_segment'
            });
          }
        });
      });

      // B. Nearby reaction segments (passing close but not connected)
      this.reactions.forEach(rxn => {
        rxn.segments.forEach(seg => {
          if (seg.from.id === node.id || seg.to.id === node.id) return;

          let minDist = Infinity;
          let closestPt = null;

          seg.points.forEach(pt => {
            const dist = Math.hypot(pt.x - node.x, pt.y - node.y);
            if (dist < minDist) {
              minDist = dist;
              closestPt = pt;
            }
          });

          if (minDist < 100 && closestPt) {
            const angle = Math.atan2(closestPt.y - node.y, closestPt.x - node.x);
            const weight = ((100 - minDist) / 100) * 0.8;
            node.restrictedAngles.push({
              angle: angle,
              weight: weight,
              type: 'nearby_segment'
            });
          }
        });
      });

      // C. Nearby metabolite circles
      node.nearbyNodes.forEach(other => {
        const dist = Math.hypot(other.x - node.x, other.y - node.y);
        if (dist < 150) {
          const angle = Math.atan2(other.y - node.y, other.x - node.x);
          const weight = ((150 - dist) / 150) * 1.0;
          node.restrictedAngles.push({
            angle: angle,
            weight: weight,
            type: 'nearby_node'
          });
        }
      });
    });
  }

  /**
   * Dynamically positions metabolite labels in a two-pass algorithm to avoid collisions
   * with metabolite circles, reaction lines, other labels, and reaction badges.
   */
  updateLabelPositions() {
    if (!this.textContainer || this.metabNodes.length === 0) return;

    const normalizeAngle = (angle) => {
      while (angle < -Math.PI) angle += 2 * Math.PI;
      while (angle > Math.PI) angle -= 2 * Math.PI;
      return angle;
    };

    const padding = 8; // padding around the circle

    // Pass 1: Measure text size and place at preferred angle
    this.metabNodes.forEach(node => {
      if (!node.textElement) return;

      const labelText = node.textElement.text;
      const fontSize = Number(node.textElement.style.fontSize) || this.baseFontSize;
      const size = measureTextSize(labelText, fontSize, 'Outfit, sans-serif');
      node.labelWidth = size.width;
      node.labelHeight = size.height;

      const radius = node.renderedRadius || 18;
      const distToLabel = radius + padding;
      const theta = node.preferredAngle !== undefined ? node.preferredAngle : 0;

      const x = node.x + distToLabel * Math.cos(theta);
      const y = node.y + distToLabel * Math.sin(theta);
      const ax = 0.5 - 0.5 * Math.cos(theta);
      const ay = 0.5 - 0.5 * Math.sin(theta);

      node.pass1Rect = {
        xMin: x - ax * node.labelWidth,
        xMax: x + (1 - ax) * node.labelWidth,
        yMin: y - ay * node.labelHeight,
        yMax: y + (1 - ay) * node.labelHeight
      };
    });

    // Pass 2: Evaluate 12 candidate angles and pick the best one
    const numCandidates = 12;
    const candidateAngles = [];
    for (let i = 0; i < numCandidates; i++) {
      candidateAngles.push((i * 2 * Math.PI) / numCandidates - Math.PI);
    }

    this.metabNodes.forEach(node => {
      if (!node.textElement) return;

      const radius = node.renderedRadius || 18;
      const distToLabel = radius + padding;
      const W = node.labelWidth;
      const H = node.labelHeight;
      const prefTheta = node.preferredAngle !== undefined ? node.preferredAngle : 0;

      let bestTheta = prefTheta;
      let minPenalty = Infinity;

      candidateAngles.forEach(theta => {
        let penalty = 0;

        const cx = node.x + distToLabel * Math.cos(theta);
        const cy = node.y + distToLabel * Math.sin(theta);
        const ax = 0.5 - 0.5 * Math.cos(theta);
        const ay = 0.5 - 0.5 * Math.sin(theta);

        const cRect = {
          xMin: cx - ax * W,
          xMax: cx + (1 - ax) * W,
          yMin: cy - ay * H,
          yMax: cy + (1 - ay) * H
        };

        // 1. Collision with neighboring circles (metabolite nodes)
        if (node.nearbyNodes) {
          node.nearbyNodes.forEach(other => {
            const rOther = (other.renderedRadius || 18) + 6; // Add a 6px visual gap from neighboring circles
            const px = Math.max(cRect.xMin, Math.min(other.x, cRect.xMax));
            const py = Math.max(cRect.yMin, Math.min(other.y, cRect.yMax));
            const dist = Math.hypot(other.x - px, other.y - py);
            if (dist < rOther) {
              penalty += 50.0; // High penalty for circle overlap
            }
          });
        }

        // 2. Overlap with incident reaction segments or nearby segments
        if (node.restrictedAngles) {
          node.restrictedAngles.forEach(restricted => {
            const diff = Math.abs(normalizeAngle(theta - restricted.angle));
            const angleThreshold = Math.PI / 4; // 45 degrees
            if (diff < angleThreshold) {
              penalty += restricted.weight * (1.0 - diff / angleThreshold) * 6.0;
            }
          });
        }

        // 3. Label-Label Overlaps with nearby nodes' labels
        if (node.nearbyNodes) {
          node.nearbyNodes.forEach(other => {
            if (other.pass1Rect) {
              const gapX = 12; // Minimum 12px horizontal gap
              const gapY = 6;  // Minimum 6px vertical gap
              const overlap = !(
                cRect.xMax + gapX < other.pass1Rect.xMin ||
                cRect.xMin - gapX > other.pass1Rect.xMax ||
                cRect.yMax + gapY < other.pass1Rect.yMin ||
                cRect.yMin - gapY > other.pass1Rect.yMax
              );
              if (overlap) {
                penalty += 25.0; // Stronger penalty for label proximity overlap
              }
            }
          });
        }

        // 4. Collision with Reaction Badges
        this.reactions.forEach(rxn => {
          if (rxn.labelX && rxn.labelY && rxn.badgeWidth && rxn.badgeHeight) {
            const bxMin = rxn.labelX - rxn.badgeWidth / 2;
            const bxMax = rxn.labelX + rxn.badgeWidth / 2;
            const byMin = rxn.labelY - rxn.badgeHeight / 2;
            const byMax = rxn.labelY + rxn.badgeHeight / 2;

            const overlap = !(
              cRect.xMax < bxMin ||
              cRect.xMin > bxMax ||
              cRect.yMax < byMin ||
              cRect.yMin > byMax
            );
            if (overlap) {
              penalty += 10.0;
            }
          }
        });

        // 5. Deviation from preferred angle
        const angleDiff = Math.abs(normalizeAngle(theta - prefTheta));
        penalty += angleDiff * 3.0; // Keep near original layout if possible

        if (penalty < minPenalty) {
          minPenalty = penalty;
          bestTheta = theta;
        }
      });

      // Apply best placement properties
      const finalX = node.x + distToLabel * Math.cos(bestTheta);
      const finalY = node.y + distToLabel * Math.sin(bestTheta);
      const finalAnchorX = 0.5 - 0.5 * Math.cos(bestTheta);
      const finalAnchorY = 0.5 - 0.5 * Math.sin(bestTheta);

      node.textElement.x = finalX;
      node.textElement.y = finalY;
      node.textElement.anchor.set(finalAnchorX, finalAnchorY);

      node.finalRect = {
        xMin: finalX - finalAnchorX * W,
        xMax: finalX + (1 - finalAnchorX) * W,
        yMin: finalY - finalAnchorY * H,
        yMax: finalY + (1 - finalAnchorY) * H
      };
      node.pass1Rect = node.finalRect;
    });
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
    g.stroke({ width: 10.0, color: 0x2b76b4, alpha: 0.55 });
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

    // Run dynamic label positions
    this.updateLabelPositions();
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

  getUsableCenterX() {
    if (window.innerWidth <= 768) {
      return this.app.renderer.width / 2;
    }
    const leftSpace = 420;
    const rightPanel = document.getElementById('inspector-panel');
    const rightSpace = (rightPanel && !rightPanel.classList.contains('hidden-panel')) ? 400 : 0;
    return (this.app.renderer.width + leftSpace - rightSpace) / 2;
  }


  /**
   * Fits the entire metabolic map centered inside the viewport canvas.
   */
  fitMapToScreen(smooth = true, startupAnimation = false) {
    console.log('[MapRenderer] fitMapToScreen called. smooth:', smooth, 'startup:', startupAnimation);
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
    const fitZoom = Math.min(scaleX, scaleY);
    const clampedFitZoom = Math.max(0.12, Math.min(1.5, fitZoom));

    const mapCenterX = (minX + maxX) / 2;
    const mapCenterY = (minY + maxY) / 2;

    if (startupAnimation && smooth) {
      let targetX = mapCenterX;
      let targetY = mapCenterY;

      // Find the MDH reaction badge coordinate
      const mdhRxn = this.reactions.find(r => r.biggId === 'MDH');
      if (mdhRxn && mdhRxn.labelX && mdhRxn.labelY) {
        targetX = mdhRxn.labelX;
        targetY = mdhRxn.labelY;
      }

      // End zoom level should be zoomed in (closer)
      // clampedFitZoom is the scale to fit the whole map (e.g. ~0.3).
      // We zoom in by a factor of 3.3 (so zoom target is e.g. ~1.0).
      // We clamp it to a maximum of 1.8 to avoid zooming in too far on huge screens.
      this.targetZoom = Math.max(0.15, Math.min(1.8, clampedFitZoom * 3.3));
      
      const usableCenterX = this.getUsableCenterX();
      this.targetPosition.x = usableCenterX - targetX * this.targetZoom;
      this.targetPosition.y = this.app.renderer.height / 2 - targetY * this.targetZoom;

      // Start zoomed out (where the whole map fits the screen)
      this.zoom = clampedFitZoom;
      this.viewport.x = usableCenterX - mapCenterX * this.zoom;
      this.viewport.y = this.app.renderer.height / 2 - mapCenterY * this.zoom;
      this.viewport.scale.set(this.zoom);
      
      // Make the startup zoom animation slower and more majestic
      this.cameraLerpSpeed = 0.025;
      this.isCameraAnimating = true;
    } else {
      this.targetZoom = clampedFitZoom;
      this.targetPosition.x = this.getUsableCenterX() - mapCenterX * this.targetZoom;
      this.targetPosition.y = this.app.renderer.height / 2 - mapCenterY * this.targetZoom;
      this.cameraLerpSpeed = 0.1; // reset/ensure default speed

      if (smooth) {
        // Smoothly animate from the current camera state to the fitted state
        this.isCameraAnimating = true;
      } else {
        // Set instantly (no animation)
        this.zoom = this.targetZoom;
        this.viewport.x = this.targetPosition.x;
        this.viewport.y = this.targetPosition.y;
        this.viewport.scale.set(this.zoom);
        this.isCameraAnimating = false;
      }
    }
  }

  /**
   * Smoothly pans and zooms the camera to focus on a particular pathway bounding box.
   */
  focusOnPathway(pathwayMetabIds) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    let count = 0;

    console.log('[MapRenderer] focusOnPathway called with:', Array.from(pathwayMetabIds));

    this.metabNodes.forEach(node => {
      if (pathwayMetabIds.has(node.biggId)) {
        if (node.x < minX) minX = node.x;
        if (node.x > maxX) maxX = node.x;
        if (node.y < minY) minY = node.y;
        if (node.y > maxY) maxY = node.y;
        count++;
      }
    });

    console.log('[MapRenderer] focusOnPathway count:', count, 'bounds:', { minX, maxX, minY, maxY });

    if (count === 0) {
      console.warn('[MapRenderer] focusOnPathway count is 0, falling back to fitMapToScreen');
      this.fitMapToScreen();
      return;
    }

    const padding = 200;
    const boxW = Math.max(300, maxX - minX);
    const boxH = Math.max(300, maxY - minY);

    const scaleX = (this.app.renderer.width - padding) / boxW;
    const scaleY = (this.app.renderer.height - padding) / boxH;
    
    this.targetZoom = Math.max(0.15, Math.min(1.2, Math.min(scaleX, scaleY)));

    console.log('[MapRenderer] focusOnPathway renderer size:', this.app.renderer.width, 'x', this.app.renderer.height, 'scales:', scaleX, scaleY, 'targetZoom:', this.targetZoom);

    const boxCenterX = (minX + maxX) / 2;
    const boxCenterY = (minY + maxY) / 2;

    this.targetPosition.x = this.getUsableCenterX() - boxCenterX * this.targetZoom;
    this.targetPosition.y = this.app.renderer.height / 2 - boxCenterY * this.targetZoom;

    this.isCameraAnimating = true;
  }

  /**
   * Smoothly pans and zooms the camera to focus on specific coordinates.
   */
  focusOnCoordinates(x, y, targetZoom = 0.85) {
    this.targetZoom = targetZoom;
    this.targetPosition.x = this.getUsableCenterX() - x * this.targetZoom;
    this.targetPosition.y = this.app.renderer.height / 2 - y * this.targetZoom;

    this.isCameraAnimating = true;
  }

  /**
   * Smoothly zooms in centered on the middle of the screen.
   */
  zoomIn() {
    const baseZoom = this.isCameraAnimating ? this.targetZoom : this.zoom;
    this.targetZoom = Math.max(0.08, Math.min(4.0, baseZoom * 1.3));
    
    const screenCenterX = this.getUsableCenterX();
    const screenCenterY = this.app.renderer.height / 2;
    const worldCenterX = (screenCenterX - this.viewport.x) / this.zoom;
    const worldCenterY = (screenCenterY - this.viewport.y) / this.zoom;
    
    this.targetPosition.x = screenCenterX - worldCenterX * this.targetZoom;
    this.targetPosition.y = screenCenterY - worldCenterY * this.targetZoom;
    
    this.isCameraAnimating = true;
  }

  /**
   * Smoothly zooms out centered on the middle of the screen.
   */
  zoomOut() {
    const baseZoom = this.isCameraAnimating ? this.targetZoom : this.zoom;
    this.targetZoom = Math.max(0.08, Math.min(4.0, baseZoom / 1.3));
    
    const screenCenterX = this.getUsableCenterX();
    const screenCenterY = this.app.renderer.height / 2;
    const worldCenterX = (screenCenterX - this.viewport.x) / this.zoom;
    const worldCenterY = (screenCenterY - this.viewport.y) / this.zoom;
    
    this.targetPosition.x = screenCenterX - worldCenterX * this.targetZoom;
    this.targetPosition.y = screenCenterY - worldCenterY * this.targetZoom;
    
    this.isCameraAnimating = true;
  }

  /**
   * Fits the entire canvas on the screen.
   */
  zoomToCanvas() {
    this.fitMapToScreen(true, false);
  }

  /**
   * Updates camera animation using linear interpolation (lerp).
   */
  updateCamera(deltaTime) {
    if (!this.isCameraAnimating) return;

    const lerpSpeed = this.cameraLerpSpeed * deltaTime; // Adjust speed of transitions

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
      this.cameraLerpSpeed = 0.1; // reset to default normal speed
    }
  }

  /**
   * Binds pointer and wheel events to implement panning, zooming, and hit testing.
   */
  setupInteractivity() {
    const el = this.canvas;


    // Drag-to-pan & pinch implementation
    el.addEventListener('pointerdown', (e) => {
      this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (this.activePointers.size === 1) {
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
        el.style.cursor = 'grabbing';
      } else if (this.activePointers.size === 2) {
        // Transition from panning to pinching
        this.isDragging = false;
        this.isPinching = true;
        this.isCameraAnimating = false;

        const pointers = Array.from(this.activePointers.values());
        this.pinchStartDist = Math.hypot(pointers[0].x - pointers[1].x, pointers[0].y - pointers[1].y);
        this.pinchStartCenter = {
          x: (pointers[0].x + pointers[1].x) / 2,
          y: (pointers[0].y + pointers[1].y) / 2
        };
        this.pinchStartZoom = this.zoom;
        this.pinchStartViewport = { x: this.viewport.x, y: this.viewport.y };
      }

      try {
        el.setPointerCapture(e.pointerId);
      } catch (err) {}
    });

    el.addEventListener('pointermove', (e) => {
      const canvasX = e.clientX;
      const canvasY = e.clientY;

      if (!this.activePointers.has(e.pointerId)) {
        // Handle mouse hover tooltips and grab/pointer cursor
        const node = this.hitTestMetabolite(canvasX, canvasY);
        el.style.cursor = (node || this.hoveredReaction) ? 'pointer' : 'grab';

        if (node !== this.hoveredNode) {
          this.hoveredNode = node;
          
          // Custom event to main controller for tooltips
          const event = new CustomEvent('metabolite-hover', { detail: node });
          el.dispatchEvent(event);
        }
        return;
      }

      this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (this.isPinching && this.activePointers.size === 2) {
        const pointers = Array.from(this.activePointers.values());
        const dist = Math.hypot(pointers[0].x - pointers[1].x, pointers[0].y - pointers[1].y);
        const center = {
          x: (pointers[0].x + pointers[1].x) / 2,
          y: (pointers[0].y + pointers[1].y) / 2
        };

        if (this.pinchStartDist > 5) {
          const ratio = dist / this.pinchStartDist;
          let newZoom = this.pinchStartZoom * ratio;
          
          // Clamp zoom between 0.08x (far) and 4.0x (close)
          newZoom = Math.max(0.08, Math.min(4.0, newZoom));

          const actualRatio = newZoom / this.pinchStartZoom;

          // Scale and translate viewport centered on the pinch point
          const nextX = center.x - (this.pinchStartCenter.x - this.pinchStartViewport.x) * actualRatio;
          const nextY = center.y - (this.pinchStartCenter.y - this.pinchStartViewport.y) * actualRatio;

          this.zoom = newZoom;
          this.viewport.scale.set(this.zoom);
          this.viewport.x = nextX;
          this.viewport.y = nextY;

          this.targetZoom = this.zoom;
          this.targetPosition.x = this.viewport.x;
          this.targetPosition.y = this.viewport.y;
        }
        return;
      }

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

      // Otherwise, handle mouse hover tooltips and grab/pointer cursor
      const node = this.hitTestMetabolite(canvasX, canvasY);
      el.style.cursor = (node || this.hoveredReaction) ? 'pointer' : 'grab';

      if (node !== this.hoveredNode) {
        this.hoveredNode = node;
        
        // Custom event to main controller for tooltips
        const event = new CustomEvent('metabolite-hover', { detail: node });
        el.dispatchEvent(event);
      }
    });

    const endDrag = (e) => {
      this.activePointers.delete(e.pointerId);

      if (this.isPinching) {
        if (this.activePointers.size < 2) {
          this.isPinching = false;
          // If 1 pointer is still down, transition back to dragging
          if (this.activePointers.size === 1) {
            this.isDragging = true;
            this.isCameraAnimating = false;
            const remainingPointer = Array.from(this.activePointers.values())[0];
            this.dragStart.x = remainingPointer.x;
            this.dragStart.y = remainingPointer.y;
            this.viewportStart.x = this.viewport.x;
            this.viewportStart.y = this.viewport.y;
          }
        }
      } else if (this.isDragging) {
        if (this.activePointers.size === 0) {
          this.isDragging = false;
          
          const canvasX = e.clientX;
          const canvasY = e.clientY;
          const node = this.hitTestMetabolite(canvasX, canvasY);
          el.style.cursor = (node || this.hoveredReaction) ? 'pointer' : 'grab';
          
          if (!node) {
            this.hoveredNode = null;
            const event = new CustomEvent('metabolite-hover', { detail: null });
            el.dispatchEvent(event);
          } else {
            this.hoveredNode = node;
            const event = new CustomEvent('metabolite-hover', { detail: node });
            el.dispatchEvent(event);
          }
        }
      }

      try {
        el.releasePointerCapture(e.pointerId);
      } catch (err) {}
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

        // Hide tooltip
        this.hoveredNode = null;
        const event = new CustomEvent('metabolite-hover', { detail: null });
        el.dispatchEvent(event);
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
  renderUpdate(simMetabolites, simReactions, animationFrameCount, isDead = false, isPaused = false) {
    if (!this.viewport) return;

    this.lastSimReactions = simReactions;
    this.updateReactionBadgeHighlight();

    if (this.visualFrameCount === undefined) {
      this.visualFrameCount = 0;
    }
    if (!isPaused && !isDead) {
      this.visualFrameCount += 1;
    }

    // Update camera layout values dynamically to center focused highlights if needed
    // 1. Draw Metabolites Pulsation
    const mg = this.metaboliteGraphics;
    mg.clear();

    this.metabNodes.forEach(node => {
      const simMetab = simMetabolites[node.biggId];
      if (!simMetab) return;

      // Visual concentration cap for water (55M is too massive for visual scaling)
      const concentration = node.biggId.includes('h2o') ? 1.0 : simMetab.concentration;

      const baseRadius = node.biggId.includes('glc__D') ? 22 : 15;
      const scaleFactor = 0.5 + Math.sqrt(concentration) * 0.6;

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

      if (!this.flashingMetaboliteIds) {
        this.flashingMetaboliteIds = new Set();
      }

      const isFlashing = this.flashingMetaboliteIds.has(node.biggId);
      let isDeviating = false;
      let deviationColor = 0;
      let radius = baseRadius * Math.max(0.4, Math.min(3.5, scaleFactor));

      if (isFlashing) {
        const pulse = 1.0 + Math.sin(animationFrameCount * 0.18) * 0.22;
        radius = radius * pulse;
        color = 0xef4444; // vibrant warning red
        glowColor = 0xfc8181;
        alpha = 0.95;
        isDeviating = true;
        deviationColor = 0xef4444;
      } else {
        // Check for deviation from the dynamic kinetic target (targetConcentration)
        const target = simMetab.targetConcentration || simMetab.concentration;
        const ratio = simMetab.concentration / target;

        if (ratio > 1.15) {
          // Accumulation: Orange warning
          color = 0xf97316; // orange
          glowColor = 0xea580c;
          isDeviating = true;
          deviationColor = 0xf97316;
        } else if (ratio < 0.85) {
          // Deficit: Cyan/Light blue warning
          color = 0x06b6d4; // cyan
          glowColor = 0x0891b2;
          isDeviating = true;
          deviationColor = 0x06b6d4;
        }
      }

      node.renderedRadius = radius;
      if (isDead) {
        // Black and white grayscale conversion for dead cells
        color = 0x475569; // slate gray
        glowColor = 0x334155;
        alpha = 0.45;
        isDeviating = false; // Disable deviation warnings visually when dead
      }

      // Draw highlighted ring if selected, hovered, or dynamically deviating
      if (this.selectedNodeId === node.id) {
        mg.circle(node.x, node.y, radius + 4).stroke({ width: 3.5, color: 0x818cf8, alpha: 1.0 });
      } else if (this.hoveredNode && this.hoveredNode.id === node.id) {
        mg.circle(node.x, node.y, radius + 3).stroke({ width: 2.0, color: 0xffffff, alpha: 0.8 });
      } else if (isDeviating) {
        const pulseAlpha = 0.35 + Math.sin(Date.now() / 180) * 0.15;
        mg.circle(node.x, node.y, radius + 4.5).stroke({ width: 2.0, color: deviationColor, alpha: pulseAlpha });
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

      // No flow for inactive reactions or if the cell is dead
      if (absFlux < 0.02 || isDead) return;

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
            t = (this.visualFrameCount * speedFactor + offset) % 1.0;
          } else {
            // Reversible flow (backward): start at 1, go to 0
            t = 1.0 - ((this.visualFrameCount * speedFactor + offset) % 1.0);
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

    // Run dynamic label positioning to avoid overlaps
    this.updateLabelPositions();
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
