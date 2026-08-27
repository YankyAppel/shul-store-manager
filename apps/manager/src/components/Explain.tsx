import { useEffect, useState } from 'react';

export function Explain({
  id,
  sentence,
  children,
}: {
  id: string;
  sentence: string;
  children: string;
}) {
  const [dismissed, setDismissed] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let active = true;
    void window.storeApi.settings.getDevice().then((settings) => {
      if (active) setDismissed(settings.explainDismissals.includes(id));
    });
    return () => {
      active = false;
    };
  }, [id]);

  if (dismissed) return null;
  return (
    <div className="explain">
      <p>{sentence}</p>
      <button type="button" onClick={() => setOpen((value) => !value)}>
        {open ? 'Hide explanation' : 'What is this?'}
      </button>
      {open && <p className="explain-detail">{children}</p>}
      <button
        type="button"
        className="explain-dismiss"
        onClick={() => {
          setDismissed(true);
          void window.storeApi.settings.dismissExplanation(id);
        }}
      >
        Don&apos;t show this again
      </button>
    </div>
  );
}
