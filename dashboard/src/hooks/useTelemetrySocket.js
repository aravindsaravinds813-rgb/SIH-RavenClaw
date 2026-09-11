import { useEffect, useRef, useState } from 'react';
import { initialTelemetry, nextDemoFrame } from '../data/demoTelemetry';

const TREND_LENGTH = 40;
const DEMO_TICK_MS = 1200;

// Reads the socket URL from Vite env, e.g. VITE_TELEMETRY_WS=ws://localhost:8765/uav-01
const SOCKET_URL = import.meta.env?.VITE_TELEMETRY_WS;

function pushTrend(trend, frame) {
  const point = {
    t: new Date(frame.timestamp).toLocaleTimeString('en-US', { hour12: false }),
    rpm: Math.round(frame.engine.rpm),
    egt: Math.round(frame.engine.egt),
    cht: Math.round(frame.engine.cht),
    voltage: Number(frame.battery.voltage.toFixed(1)),
    current: Number(frame.battery.current.toFixed(1)),
  };
  const grown = trend.length >= TREND_LENGTH ? trend.slice(1) : trend;
  return [...grown, point];
}

// Provides live UAV telemetry over WebSocket when VITE_TELEMETRY_WS is
// configured and reachable; otherwise streams realistic simulated frames
// so the dashboard is fully demoable offline (ground-station-less demo).
export default function useTelemetrySocket() {
  const [telemetry, setTelemetry] = useState(initialTelemetry);
  const [connected, setConnected] = useState(false);
  const [mode, setMode] = useState(SOCKET_URL ? 'connecting' : 'simulated');
  const socketRef = useRef(null);
  const demoTimerRef = useRef(null);
  const trendRef = useRef([]);

  useEffect(() => {
    let cancelled = false;

    function startDemo() {
      if (demoTimerRef.current) return;
      setMode('simulated');
      setConnected(true);
      demoTimerRef.current = setInterval(() => {
        setTelemetry((prev) => {
          const frame = nextDemoFrame(prev);
          trendRef.current = pushTrend(trendRef.current, frame);
          return { ...frame, trend: trendRef.current, connected: true };
        });
      }, DEMO_TICK_MS);
    }

    if (!SOCKET_URL) {
      startDemo();
      return () => clearInterval(demoTimerRef.current);
    }

    try {
      const ws = new WebSocket(SOCKET_URL);
      socketRef.current = ws;

      ws.onopen = () => {
        if (cancelled) return;
        setConnected(true);
        setMode('live');
      };

      ws.onmessage = (event) => {
        if (cancelled) return;
        try {
          const frame = JSON.parse(event.data);
          trendRef.current = pushTrend(trendRef.current, frame);
          setTelemetry({ ...frame, trend: trendRef.current, connected: true });
        } catch (err) {
          // Malformed frame from ground-control link; ignore and keep last good state.
        }
      };

      ws.onerror = () => {
        if (cancelled) return;
        setConnected(false);
      };

      ws.onclose = () => {
        if (cancelled) return;
        setConnected(false);
        // Fall back to simulated telemetry so the UI keeps moving
        // (e.g. during a demo without ground-station hardware connected).
        startDemo();
      };
    } catch (err) {
      startDemo();
    }

    return () => {
      cancelled = true;
      clearInterval(demoTimerRef.current);
      demoTimerRef.current = null;
      socketRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { telemetry, connected, mode };
}
