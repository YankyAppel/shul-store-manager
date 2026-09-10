import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { CoinScene } from './CoinScene';
import heroStoneUrl from '../assets/hero-stone.jpg';

/** Time the coin holds centre stage before rising to the top. */
const INTRO_HOLD_MS = 1800;
/** Matches `--suma-coin-move` in brand.css. */
const COIN_MOVE_MS = 1100;
/** Matches `--suma-panel-move` in brand.css. */
const PANEL_MOVE_MS = 480;

export type BrandStage = 'hero' | 'rising' | 'ready';

/**
 * Plays the boot sequence once per mount: the coin turns in the centre of the
 * marble, rises to the top while shrinking, then the content fades in. Pass
 * `intro={false}` to start with the coin already pinned.
 */
export function useBrandIntro(intro: boolean): BrandStage {
  const [stage, setStage] = useState<BrandStage>(intro ? 'hero' : 'ready');
  useEffect(() => {
    if (!intro) return;
    const rise = window.setTimeout(() => setStage('rising'), INTRO_HOLD_MS);
    const ready = window.setTimeout(
      () => setStage('ready'),
      INTRO_HOLD_MS + COIN_MOVE_MS,
    );
    return () => {
      window.clearTimeout(rise);
      window.clearTimeout(ready);
    };
  }, [intro]);
  return stage;
}

export function BrandShell({
  intro = true,
  children,
  className,
}: {
  /** Play the centred-coin boot animation before showing content. */
  intro?: boolean;
  children?: ReactNode;
  className?: string;
}) {
  const stage = useBrandIntro(intro);
  const style = { '--suma-stone': `url(${heroStoneUrl})` } as CSSProperties;
  return (
    <div
      className={`suma-shell suma-shell--${stage}${className ? ` ${className}` : ''}`}
      style={style}
    >
      <div className="suma-shell__grain" />
      <div className="suma-shell__coin">
        <CoinScene className="suma-shell__coin-scene" />
      </div>
      <div className="suma-shell__content">{stage === 'ready' && children}</div>
    </div>
  );
}

interface Panel {
  key: string;
  node: ReactNode;
}

/**
 * Shows one panel at a time. When `panelKey` changes the current panel slides
 * out to the left while the next one slides in from the right; the coin above
 * stays put.
 */
export function BrandPanels({
  panelKey,
  children,
}: {
  panelKey: string;
  children: ReactNode;
}) {
  const [leaving, setLeaving] = useState<Panel | null>(null);
  const shown = useRef<Panel>({ key: panelKey, node: children });
  const outgoing = useRef<Panel | null>(null);
  if (panelKey !== shown.current.key) outgoing.current = shown.current;
  shown.current = { key: panelKey, node: children };

  useEffect(() => {
    const panel = outgoing.current;
    if (!panel) return;
    outgoing.current = null;
    setLeaving(panel);
    const timer = window.setTimeout(() => setLeaving(null), PANEL_MOVE_MS);
    return () => window.clearTimeout(timer);
  }, [panelKey]);

  return (
    <div className="suma-panels">
      {leaving && (
        <div
          key={`leave-${leaving.key}`}
          className="suma-panel suma-panel--leave"
          aria-hidden="true"
        >
          {leaving.node}
        </div>
      )}
      <div
        key={panelKey}
        className={`suma-panel${leaving ? ' suma-panel--enter' : ''}`}
      >
        {children}
      </div>
    </div>
  );
}
