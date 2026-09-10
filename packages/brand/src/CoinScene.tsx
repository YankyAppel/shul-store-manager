import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import coinFallbackUrl from '../assets/suma-coin-3d.png';
import coinReliefUrl from '../assets/suma-coin-relief.png';

const DEEP = 0x0f3323;
const COPPER = 0xb87333;

function reedingTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 2048;
  c.height = 64;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, c.width, c.height);
  const teeth = 190;
  const step = c.width / teeth;
  for (let i = 0; i < teeth; i++) {
    const g = ctx.createLinearGradient(i * step, 0, (i + 1) * step, 0);
    g.addColorStop(0, '#000');
    g.addColorStop(0.5, '#fff');
    g.addColorStop(1, '#000');
    ctx.fillStyle = g;
    ctx.fillRect(i * step, 0, step, c.height);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  return t;
}

/**
 * Cap maps baked straight into canvases: cylinder caps take their UVs sideways,
 * and the far cap is seen mirrored, so both are corrected while drawing.
 */
function capTextures(
  relief: HTMLImageElement,
  mirrored: boolean,
): { colour: THREE.Texture; bump: THREE.Texture } {
  const size = relief.naturalWidth;

  const draw = () => {
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const ctx = c.getContext('2d')!;
    ctx.translate(size / 2, size / 2);
    ctx.rotate(Math.PI / 2);
    if (mirrored) ctx.scale(-1, 1);
    ctx.drawImage(relief, -size / 2, -size / 2);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return { c, ctx };
  };

  const bumpCanvas = draw();
  const bump = new THREE.CanvasTexture(bumpCanvas.c);
  bump.colorSpace = THREE.NoColorSpace;
  bump.anisotropy = 8;

  const { c, ctx } = draw();
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const l = d[i]! / 255;
    if (l > 0.92) {
      d[i] = 0xf1;
      d[i + 1] = 0xf1;
      d[i + 2] = 0xec;
    } else {
      d[i] = 0x2a + l * 0x38;
      d[i + 1] = 0x7a + l * 0x3a;
      d[i + 2] = 0x52 + l * 0x38;
    }
    d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const colour = new THREE.CanvasTexture(c);
  colour.colorSpace = THREE.SRGBColorSpace;
  colour.anisotropy = 8;

  return { colour, bump };
}

/** Studio the metal reflects: cream ceiling, copper key light, deep green floor. */
function studioEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 512;
  const ctx = c.getContext('2d')!;
  const sky = ctx.createLinearGradient(0, 0, 0, c.height);
  sky.addColorStop(0, '#f3f4ef');
  sky.addColorStop(0.42, '#9aa79d');
  sky.addColorStop(0.52, '#20402f');
  sky.addColorStop(1, '#050b08');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, c.width, c.height);

  const softbox = (x: number, y: number, w: number, h: number, a: number) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, Math.max(w, h));
    g.addColorStop(0, `rgba(255,255,255,${a})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - w, y - h, w * 2, h * 2);
  };
  softbox(250, 120, 220, 150, 0.95);
  softbox(760, 90, 170, 120, 0.75);

  const warm = ctx.createRadialGradient(880, 260, 0, 880, 260, 260);
  warm.addColorStop(0, 'rgba(216,150,86,0.85)');
  warm.addColorStop(1, 'rgba(216,150,86,0)');
  ctx.fillStyle = warm;
  ctx.fillRect(620, 40, 520, 440);

  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromEquirectangular(tex).texture;
  pmrem.dispose();
  tex.dispose();
  return env;
}

/** The turning SUMA coin from the website hero, filling its host element. */
export function CoinScene({ className }: { className?: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [webglEnabled, setWebglEnabled] = useState(true);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !webglEnabled) return;

    const reduceMotion = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches;

    let renderer: THREE.WebGLRenderer;
    try {
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
      if (!context) {
        window.setTimeout(() => setWebglEnabled(false), 0);
        return;
      }
      renderer = new THREE.WebGLRenderer({
        canvas,
        context,
        antialias: true,
        alpha: true,
        powerPreference: 'high-performance',
      });
    } catch {
      window.setTimeout(() => setWebglEnabled(false), 0);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.6;
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
    camera.position.set(0, 0.55, 10.6);
    camera.lookAt(0, 0.1, 0);

    const env = studioEnvironment(renderer);
    scene.environment = env;

    const faceMaterial = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      metalness: 1,
      roughness: 0.22,
      bumpScale: 22,
      envMapIntensity: 2.1,
      clearcoat: 0.3,
      clearcoatRoughness: 0.35,
    });
    const backMaterial = faceMaterial.clone();

    new THREE.TextureLoader().load(coinReliefUrl, (tex) => {
      const source = tex.image as HTMLImageElement;
      const front = capTextures(source, true);
      faceMaterial.map = front.colour;
      faceMaterial.bumpMap = front.bump;
      faceMaterial.needsUpdate = true;
      const back = capTextures(source, false);
      backMaterial.map = back.colour;
      backMaterial.bumpMap = back.bump;
      backMaterial.needsUpdate = true;
      tex.dispose();
    });

    const reeding = reedingTexture();
    const rimMaterial = new THREE.MeshPhysicalMaterial({
      color: COPPER,
      metalness: 1,
      roughness: 0.28,
      bumpMap: reeding,
      bumpScale: 3,
      envMapIntensity: 2.2,
    });

    const coin = new THREE.Mesh(
      new THREE.CylinderGeometry(2.5, 2.5, 0.3, 128, 1, false),
      [rimMaterial, faceMaterial, backMaterial],
    );
    coin.rotation.x = Math.PI / 2;
    const pivot = new THREE.Group();
    pivot.add(coin);
    pivot.position.set(0, 0.35, 0);
    scene.add(pivot);

    const key = new THREE.DirectionalLight(0xfff6e6, 2.6);
    key.position.set(-4, 5, 6);
    scene.add(key);
    const copperRim = new THREE.DirectionalLight(COPPER, 2.2);
    copperRim.position.set(6, -1.5, 2.5);
    scene.add(copperRim);
    const fill = new THREE.DirectionalLight(0x9fb6a6, 0.9);
    fill.position.set(3, 2, -6);
    scene.add(fill);
    scene.add(new THREE.AmbientLight(DEEP, 1.2));

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = host;
      if (!w || !h) return;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(host);

    let raf = 0;
    const clock = new THREE.Clock();
    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (!reduceMotion) {
        const t = clock.getElapsedTime();
        pivot.rotation.y = t * 0.35;
        pivot.rotation.x = Math.sin(t * 0.45) * 0.07;
        pivot.position.y = 0.35 + Math.sin(t * 0.7) * 0.06;
      }
      renderer.render(scene, camera);
    };
    tick();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.dispose();
      coin.geometry.dispose();
      faceMaterial.map?.dispose();
      faceMaterial.bumpMap?.dispose();
      faceMaterial.dispose();
      backMaterial.map?.dispose();
      backMaterial.bumpMap?.dispose();
      backMaterial.dispose();
      rimMaterial.dispose();
      reeding.dispose();
      env.dispose();
      host.removeChild(renderer.domElement);
    };
  }, [webglEnabled]);

  return (
    <div ref={hostRef} className={className} aria-hidden="true">
      {!webglEnabled && (
        <img src={coinFallbackUrl} alt="" className="suma-coin-fallback" />
      )}
    </div>
  );
}
