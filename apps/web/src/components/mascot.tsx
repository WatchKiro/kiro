'use client';

import { cx } from '@kiro/utils';
import { useEffect, useRef, type CSSProperties } from 'react';

/*
 * The Kiro mascot as an inline, animated SVG. Paths are the brand master
 * (brand/kiro-mascot.svg). Animation matches the desktop app's splash screen:
 * a gentle float, a fin wave and the occasional blink, plus on the web the
 * eyes and visor follow the pointer. Everything stops under
 * prefers-reduced-motion.
 */

const BODY =
  'M 315.69 949.26 C 243.99 865.97 197.9 754.5 200.56 643.46 C 204.35 485.27 299.23 332.95 437.26 256.26 C 505.78 218.19 582.84 196.69 661.5 196.69 C 811.96 196.69 954.05 281.54 1037.6 404.4 C 1088.61 479.43 1114.5 569.06 1114.5 659.5 C 1114.5 691.17 1111.96 722.79 1104.69 753.69 C 1080.53 856.35 1017.21 950.63 932.88 1013.88 C 892.65 1044.06 848.76 1069.6 801.02 1086.02 C 674.63 1129.5 534.46 1113.94 421.4 1042.6 C 381.32 1017.3 346.51 985.08 315.69 949.26 Z';
const UNDERSIDE =
  'M 334 660 C 342 668 345 678 350 686.7 C 364.5 715.7 378.29 744.85 395 772.7 C 417.08 809.49 443.15 844.25 473 875.1 C 521.85 925.58 582.4 965.42 650 985.7 C 723.26 1007.68 804.84 1006.65 878 984.7 C 912.37 974.39 945.77 960.8 977 943.1 C 998.13 931.12 1016.87 916.12 1037 902.7 L 1160 885 L 1160 1180 L 170 1180 L 170 800 Z';
const FIN =
  'M 304.03 658.03 C 309.04 657.43 314.15 657.28 319.17 657.83 C 328.29 658.85 339.31 664.41 343.57 673.03 C 348.16 682.35 349.5 695.29 349.5 705.5 C 349.5 744.09 336.97 783.41 315.1 815.1 C 292.35 848.07 260.45 877.88 225.43 897.43 C 208.68 906.79 190.83 914.66 171.3 915.03 C 166.6 915.12 162.07 914.58 157.5 913.5 C 134.42 908.03 124.07 886.34 122.7 864.3 C 120.39 827.03 140.94 789.36 162.37 760.37 C 186.94 727.12 217.11 699.84 252.57 678.57 C 268 669.31 285.95 660.23 304.03 658.03 Z';
const FIN_LIP =
  'M 297.95 649.95 C 307.7 649.13 318.19 651.47 326.68 656.32 C 329.05 657.67 331.83 659.06 333.59 661.23 C 333.83 661.52 334.23 662.05 333.95 662.32 C 332.99 663.28 331.36 661.46 330.14 660.86 C 327.16 659.43 324.43 658.33 321.14 657.86 C 312.72 656.66 303.7 657.39 295.5 659.5 C 271.96 665.55 248.74 678.88 229.5 693.5 C 223.44 698.1 217.35 702.63 211.5 707.5 C 210.43 708.39 207.3 712.22 205.5 710.77 C 202.71 708.52 203.42 701.64 204.95 698.95 C 206.77 695.78 210.54 693.57 213.23 691.23 C 217.53 687.47 221.95 683.96 226.5 680.5 C 247.2 664.77 271.75 652.18 297.95 649.95 Z';
const VISOR =
  'M 867.96 347.96 C 891.3 346.02 915.53 347.22 938.35 352.65 C 959.02 357.58 978.3 366.82 994.96 380.04 C 1010.49 392.35 1023.07 408.82 1033.5 425.5 C 1051.18 453.78 1064.31 485.21 1073.88 517.12 C 1077 527.49 1080 537.84 1082.65 548.35 C 1087.94 569.23 1092.33 590.52 1095.12 611.88 C 1097.21 627.97 1099 644.69 1096.88 660.88 C 1091.79 699.97 1066.18 732.99 1032.42 752.42 C 1018.45 760.47 1003.03 766.24 988.04 772.04 C 904.62 804.29 818.29 829.43 728.88 836.88 C 691.15 840.03 649.59 837.55 615.5 819.5 C 562.64 791.51 531.12 732.81 512.88 678.12 C 505.21 655.1 500.22 631.79 499.5 607.5 C 499.35 602.49 498.45 597.51 498.5 592.5 C 498.69 573.45 502.19 553.23 509.65 535.65 C 530.59 486.35 570.74 452.48 616.27 426.27 C 653.41 404.89 692.82 388.58 733.65 375.65 C 777.29 361.85 822.3 351.77 867.96 347.96 Z';
const EYE_LEFT =
  'M 734.95 544.95 C 738.69 544.44 742.4 544.33 746.14 544.86 C 776.09 549.14 781.34 583.54 787.5 607.5 C 789.13 613.84 790.87 620.16 792.5 626.5 C 794.43 634.01 796.06 641.59 797.86 649.14 C 800.87 661.69 804.53 674.17 803.23 687.23 C 801.38 705.72 788.51 723.03 769.23 725.23 C 765.45 725.66 761.63 725.67 757.86 725.14 C 732.91 721.57 726.54 694.33 720.95 674.05 C 719.51 668.81 718.12 663.56 716.68 658.32 C 715.23 653.06 713.95 647.76 712.5 642.5 C 711.05 637.23 709.68 631.97 708.32 626.68 C 702.53 604.19 694.47 575.93 712.77 556.77 C 715.38 554.05 718.6 551.73 721.86 549.86 C 725.79 547.62 730.44 545.58 734.95 544.95 Z';
const EYE_RIGHT =
  'M 962.77 488.14 C 967.24 488.14 971.69 488.62 975.95 490.05 C 996.31 496.83 1002.03 520.74 1007.05 538.95 C 1008.48 544.17 1009.88 549.4 1011.41 554.59 C 1013.26 560.9 1014.57 567.34 1016.32 573.68 C 1018.64 582.13 1020.82 590.62 1022.86 599.14 C 1025.66 610.8 1028.69 621.99 1027.14 634.14 C 1024.91 651.49 1012.63 667.9 994.14 669.14 C 990.71 669.37 987.51 668.68 984.23 667.77 C 961.75 661.58 957.03 635.73 951.68 616.32 C 950.52 612.12 949.48 607.88 948.32 603.68 C 946.3 596.35 944.34 589.01 942.32 581.68 C 940.01 573.3 937.81 564.88 935.5 556.5 C 932.11 544.17 928.8 531.07 931.23 518.23 C 934.04 503.35 946.42 488.14 962.77 488.14 Z';

interface MascotProps {
  className?: string;
  /** Draw the ambient glow and floor shadow around the character. */
  stage?: boolean;
  /** Eyes and visor follow the pointer anywhere on the page. */
  track?: boolean;
  /** Unique prefix so several mascots on one page do not share gradient ids. */
  id?: string;
}

export function Mascot({ className, stage = true, track = true, id = 'mascot' }: MascotProps) {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = root.current;
    if (!track || !element) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    let frame = 0;
    let target = { x: 0, y: 0 };
    let current = { x: 0, y: 0 };

    const tick = () => {
      current = {
        x: current.x + (target.x - current.x) * 0.12,
        y: current.y + (target.y - current.y) * 0.12,
      };
      element.style.setProperty('--look-x', current.x.toFixed(3));
      element.style.setProperty('--look-y', current.y.toFixed(3));
      if (Math.abs(target.x - current.x) > 0.002 || Math.abs(target.y - current.y) > 0.002) {
        frame = requestAnimationFrame(tick);
      } else {
        frame = 0;
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(tick);
    };
    const onMove = (event: PointerEvent) => {
      const rect = element.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      // Normalise to -1..1 over roughly a viewport of travel, then clamp.
      target = {
        x: Math.max(-1, Math.min(1, (event.clientX - cx) / (window.innerWidth * 0.45))),
        y: Math.max(-1, Math.min(1, (event.clientY - cy) / (window.innerHeight * 0.45))),
      };
      schedule();
    };
    const onLeave = () => {
      target = { x: 0, y: 0 };
      schedule();
    };

    window.addEventListener('pointermove', onMove, { passive: true });
    document.documentElement.addEventListener('pointerleave', onLeave);
    return () => {
      window.removeEventListener('pointermove', onMove);
      document.documentElement.removeEventListener('pointerleave', onLeave);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [track]);

  return (
    <div
      ref={root}
      aria-hidden
      className={cx('mascot relative', className)}
      style={{ '--look-x': 0, '--look-y': 0 } as CSSProperties}
    >
      {stage && (
        <>
          <div className="mascot-glow absolute inset-[-10%] rounded-full" />
          <div className="mascot-shadow absolute bottom-[-6%] left-1/2 h-[8%] w-[56%] -translate-x-1/2 rounded-full" />
        </>
      )}
      <svg
        viewBox="110 150 1020 1020"
        className="mascot-body relative size-full overflow-visible"
        focusable="false"
      >
        <defs>
          <linearGradient
            id={`${id}-body`}
            gradientUnits="userSpaceOnUse"
            x1="350"
            y1="250"
            x2="900"
            y2="1000"
          >
            <stop offset="0" stopColor="#f8f8fb" />
            <stop offset="1" stopColor="#f8f7fb" />
          </linearGradient>
          <linearGradient
            id={`${id}-under`}
            gradientUnits="userSpaceOnUse"
            x1="640"
            y1="660"
            x2="640"
            y2="1110"
          >
            <stop offset="0" stopColor="#cdc3fc" />
            <stop offset="0.5" stopColor="#cbc1fb" />
            <stop offset="1" stopColor="#c8befa" />
          </linearGradient>
          <linearGradient
            id={`${id}-fin`}
            gradientUnits="userSpaceOnUse"
            x1="260"
            y1="650"
            x2="180"
            y2="930"
          >
            <stop offset="0" stopColor="#cdc2fc" />
            <stop offset="1" stopColor="#c9befa" />
          </linearGradient>
          <linearGradient
            id={`${id}-visor`}
            gradientUnits="userSpaceOnUse"
            x1="700"
            y1="350"
            x2="900"
            y2="840"
          >
            <stop offset="0" stopColor="#231a3a" />
            <stop offset="1" stopColor="#241a3b" />
          </linearGradient>
          <linearGradient
            id={`${id}-sheen`}
            gradientUnits="userSpaceOnUse"
            x1="500"
            y1="350"
            x2="1100"
            y2="850"
          >
            <stop offset="0" stopColor="#ffffff" stopOpacity="0" />
            <stop offset="0.45" stopColor="#ffffff" stopOpacity="0" />
            <stop offset="0.5" stopColor="#ffffff" stopOpacity="0.16" />
            <stop offset="0.55" stopColor="#ffffff" stopOpacity="0" />
            <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
          </linearGradient>
          <clipPath id={`${id}-body-clip`}>
            <path d={BODY} />
          </clipPath>
          <clipPath id={`${id}-visor-clip`}>
            <path d={VISOR} />
          </clipPath>
        </defs>

        <path d={BODY} fill={`url(#${id}-body)`} />
        <g clipPath={`url(#${id}-body-clip)`}>
          <path d={UNDERSIDE} fill={`url(#${id}-under)`} />
        </g>

        <g className="mascot-fin">
          <path d={FIN} transform="translate(0 13)" fill={`url(#${id}-fin)`} />
          <path d={FIN_LIP} fill={`url(#${id}-fin)`} />
          <path d={FIN} fill={`url(#${id}-body)`} />
        </g>

        <g className="mascot-visor">
          <path d={VISOR} fill={`url(#${id}-visor)`} />
          <g clipPath={`url(#${id}-visor-clip)`}>
            <rect
              className="mascot-sheen"
              x="400"
              y="300"
              width="800"
              height="600"
              fill={`url(#${id}-sheen)`}
            />
          </g>
          <g className="mascot-eyes" fill="#fdfdfd">
            <path className="mascot-eye" d={EYE_LEFT} />
            <path className="mascot-eye" d={EYE_RIGHT} />
          </g>
        </g>
      </svg>
    </div>
  );
}
