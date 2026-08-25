import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
type Config = { host: string; port: string; token: string; storeName: string };
const key = 'kiosk-config';
function App() {
  const [config, setConfig] = useState<Config>(() =>
    JSON.parse(
      localStorage.getItem(key) ||
        '{"host":"","port":"3939","token":"","storeName":""}',
    ),
  );
  const [paired, setPaired] = useState(!!config.token);
  const [form, setForm] = useState({ code: '', name: 'Kiosk', adminPin: '' });
  const [cart, setCart] = useState<
    { productId?: string; barcode?: string; quantity: number }[]
  >([]);
  const [code, setCode] = useState('');
  const [total, setTotal] = useState<number>();
  const api = (path: string, opt?: RequestInit) =>
    fetch(`http://${config.host}:${config.port}${path}`, {
      ...opt,
      headers: {
        Authorization: `Bearer ${config.token}`,
        'content-type': 'application/json',
        ...(opt?.headers || {}),
      },
    });
  useEffect(() => {
    if (!paired || !cart.length) return;
    void api('/api/cart/price', {
      method: 'POST',
      body: JSON.stringify({ lines: cart }),
    })
      .then((r) => r.json())
      .then((x) => setTotal(x.totalCents))
      .catch(() => setPaired(false));
  }, [cart, paired]);
  if (!paired)
    return (
      <main>
        <h1>Pair this kiosk</h1>
        <input
          placeholder="Manager IP or host"
          value={config.host}
          onChange={(e) => setConfig({ ...config, host: e.target.value })}
        />
        <input
          placeholder="Port"
          value={config.port}
          onChange={(e) => setConfig({ ...config, port: e.target.value })}
        />
        <input
          placeholder="6 digit code"
          value={form.code}
          onChange={(e) => setForm({ ...form, code: e.target.value })}
        />
        <input
          placeholder="Kiosk name"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
        <input
          placeholder="Admin PIN"
          type="password"
          value={form.adminPin}
          onChange={(e) => setForm({ ...form, adminPin: e.target.value })}
        />
        <button
          onClick={async () => {
            const r = await fetch(
              `http://${config.host}:${config.port}/api/pair`,
              {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(form),
              },
            );
            const x = await r.json();
            if (x.token) {
              const c = { ...config, token: x.token };
              setConfig(c);
              localStorage.setItem(key, JSON.stringify(c));
              setPaired(true);
            } else alert(x.error);
          }}
        >
          Pair
        </button>
      </main>
    );
  return (
    <main>
      <h1>{config.storeName || 'Self checkout'}</h1>
      <h2>
        {cart.length ? 'Scan another item' : 'Touch to start / scan an item'}
      </h2>
      <input
        autoFocus
        value={code}
        onChange={(e) => setCode(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && code) {
            setCart([...cart, { barcode: code, quantity: 1 }]);
            setCode('');
          }
        }}
        placeholder="Scan or type barcode"
      />
      <ul>
        {cart.map((x, i) => (
          <li key={i}>
            {x.barcode || x.productId} × {x.quantity}{' '}
            <button onClick={() => setCart(cart.filter((_, j) => j !== i))}>
              Remove
            </button>
          </li>
        ))}
      </ul>
      <h2>{total === undefined ? '…' : `$${(total / 100).toFixed(2)}`}</h2>
      <button
        disabled={!cart.length}
        onClick={async () => {
          const id = crypto.randomUUID();
          localStorage.setItem('inflight', id);
          const lines = cart.map((x) => ({
            productId: x.productId!,
            quantity: x.quantity,
            barcodeUsed: x.barcode || null,
          }));
          alert(
            JSON.stringify(
              await (
                await api('/api/charges', {
                  method: 'POST',
                  body: JSON.stringify({
                    chargeReference: id,
                    idempotencyKey: id,
                    lines,
                  }),
                })
              ).json(),
            ),
          );
          localStorage.removeItem('inflight');
          setCart([]);
        }}
      >
        Pay with card
      </button>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
