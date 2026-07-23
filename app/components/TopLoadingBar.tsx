import { useEffect, useRef, useState } from "react";
import { useNavigation } from "@remix-run/react";

export function TopLoadingBar() {
  const navigation = useNavigation();
  const active = navigation.state !== "idle";

  const [visible, setVisible] = useState(false);
  const [progress, setProgress] = useState(0);
  const growTimer = useRef<ReturnType<typeof setInterval>>();
  const hideTimer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    clearInterval(growTimer.current);
    clearTimeout(hideTimer.current);

    if (active) {
      setVisible(true);
      setProgress(0);
      const raf = requestAnimationFrame(() => setProgress(20));
      growTimer.current = setInterval(() => {
        setProgress((prev) => (prev < 88 ? prev + (88 - prev) * 0.15 : prev));
      }, 250);
      return () => cancelAnimationFrame(raf);
    }

    setProgress((prev) => (prev > 0 ? 100 : prev));
    hideTimer.current = setTimeout(() => {
      setVisible(false);
      setProgress(0);
    }, 300);

    return () => {
      clearInterval(growTimer.current);
      clearTimeout(hideTimer.current);
    };
  }, [active]);

  if (!visible) return null;

  return (
    <div className="top-loading-bar-track" aria-hidden="true">
      <div
        className="top-loading-bar-fill"
        style={{
          width: `${progress}%`,
          opacity: active ? 1 : 0,
        }}
      >
        <div className="top-loading-bar-glow" />
      </div>
      <style>{`
        .top-loading-bar-track {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          height: 2px;
          z-index: 9999;
          pointer-events: none;
          overflow: hidden;
        }
        .top-loading-bar-fill {
          position: relative;
          height: 100%;
          background: linear-gradient(90deg, #1f7de0, #6ab8ff);
          box-shadow: 0 0 8px rgba(31, 125, 224, 0.7);
          transition: width 250ms ease-out, opacity 300ms ease-in;
        }
        .top-loading-bar-glow {
          position: absolute;
          top: 0;
          bottom: 0;
          width: 40%;
          background: linear-gradient(
            90deg,
            rgba(255, 255, 255, 0) 0%,
            rgba(255, 255, 255, 0.95) 50%,
            rgba(255, 255, 255, 0) 100%
          );
          animation: top-loading-bar-sweep 1.1s ease-in-out infinite;
        }
        @keyframes top-loading-bar-sweep {
          0% {
            transform: translateX(-100%);
          }
          100% {
            transform: translateX(250%);
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .top-loading-bar-glow {
            animation: none;
          }
        }
      `}</style>
    </div>
  );
}
