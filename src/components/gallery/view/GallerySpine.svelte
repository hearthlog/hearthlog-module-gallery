<script lang="ts">
    import { format } from 'date-fns';
    import type { GalleryMonthSummary } from '../../../data/gallery.js';
    import { formatNumber } from '@hearthlog/sdk/format';
    import { listAxis, monthOffset, nearestKey, shiftMonthKey } from '@hearthlog/sdk/axis';

    let {
        months,
        first,
        last,
        active = false,
        onJump,
        onLatest,
    }: {
        /** Months that hold photos, newest first. */
        months: GalleryMonthSummary[];
        /** The months on screen. */
        first: string;
        last: string;
        /** Phones show the spine while the list scrolls. */
        active?: boolean;
        onJump: (month: string) => void;
        onLatest: () => void;
    } = $props();

    let root = $state<HTMLDivElement>();
    let canvas = $state<HTMLCanvasElement>();
    let width = $state(0);
    let height = $state(0);
    let hover = $state<string | null>(null);
    let dragging = $state(false);
    let themeRevision = $state(0);

    const axis = $derived(listAxis(months.map((month) => month.month), { descending: true }));
    const photosByMonth = $derived(new Map(months.map((month) => [month.month, month.photos])));
    const newest = $derived(months[0]?.month ?? '');
    const total = $derived(newest ? monthOffset(months[months.length - 1].month, newest) + 1 : 0);
    const wide = $derived(width >= 48);
    const padding = 18;
    /** A month's share of the rail; a short library keeps a compact scale in the middle. */
    const step = $derived(total > 0 ? Math.min(24, Math.max(0.5, (height - padding * 2) / total)) : 0);
    const top = $derived(Math.max(padding, (height - step * total) / 2));
    const shown = $derived(active || dragging || hover !== null);

    /** The rail reads newest first, so the newest month sits at the top. */
    const monthY = (month: string) => top + (monthOffset(newest, month) + 0.5) * step;
    const monthAt = (y: number) => shiftMonthKey(newest, -Math.max(0, Math.min(total - 1, Math.floor((y - top) / step))));
    const label = (month: string) => format(new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1), 'MMMM yyyy');

    // Colours follow the theme, which can change while the page is open.
    $effect(() => {
        const observer = new MutationObserver(() => themeRevision++);
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
        const media = window.matchMedia('(prefers-color-scheme: dark)');
        const changed = () => themeRevision++;
        media.addEventListener('change', changed);
        return () => {
            observer.disconnect();
            media.removeEventListener('change', changed);
        };
    });

    $effect(() => {
        void themeRevision;
        if (!canvas || !width || !height || !newest) return;
        const ratio = window.devicePixelRatio || 1;
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(height * ratio);
        const context = canvas.getContext('2d');
        if (!context) return;
        const style = getComputedStyle(canvas);
        const color = (name: string) => style.getPropertyValue(name).trim();
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        context.clearRect(0, 0, width, height);

        const right = wide ? 10 : 4;
        if (first && last) {
            const bandTop = monthY(first) - step / 2 - 4;
            const bandBottom = monthY(last) + step / 2 + 4;
            context.fillStyle = color('--stor-accent-soft');
            context.beginPath();
            if (wide) context.roundRect(4, bandTop, width - 8, Math.max(10, bandBottom - bandTop), 7);
            else context.roundRect(width - 11, bandTop, 8, Math.max(14, bandBottom - bandTop), 4);
            context.fill();
        }

        const peak = months[0]?.peak || 1;
        const thickness = Math.max(1, Math.min(4, step * 0.6));
        for (let offset = 0; offset < total; offset++) {
            const month = shiftMonthKey(newest, -offset);
            const y = top + (offset + 0.5) * step;
            const photos = photosByMonth.get(month);
            if (!photos) {
                context.globalAlpha = 1;
                context.fillStyle = color('--stor-border');
                context.fillRect(width - right - 2, y - 0.5, 2, 1);
                continue;
            }
            const inView = month <= first && month >= last;
            const length = (wide ? 4 : 3) + (wide ? 22 : 8) * Math.sqrt(photos / peak);
            context.globalAlpha = inView ? 1 : 0.55;
            context.fillStyle = inView ? color('--stor-accent-strong') : color('--stor-muted-text');
            context.fillRect(width - right - length, y - thickness / 2, length, thickness);
        }
        context.globalAlpha = 1;

        if (wide) {
            context.font = `600 10.5px ${color('--stor-font-sans') || 'system-ui'}`;
            context.textBaseline = 'middle';
            context.fillStyle = color('--stor-muted-text');
            let previous = -Infinity;
            for (let offset = 0; offset < total; offset++) {
                const month = shiftMonthKey(newest, -offset);
                if (offset > 0 && !month.endsWith('-01')) continue;
                const y = top + (offset + 0.5) * step;
                if (y - previous < 18) continue;
                context.fillText(month.slice(0, 4), 8, y);
                previous = y;
            }
        }

        if (hover) {
            context.globalAlpha = 0.55;
            context.fillStyle = color('--stor-ink');
            context.fillRect(wide ? 4 : 0, monthY(hover) - 0.5, width - (wide ? 8 : 0), 1);
            context.globalAlpha = 1;
        }
    });

    let jumped = '';
    function point(event: PointerEvent): string {
        const month = monthAt(event.clientY - root!.getBoundingClientRect().top);
        hover = month;
        return month;
    }

    function jump(month: string) {
        const target = nearestKey(axis, month);
        if (target === jumped) return;
        jumped = target;
        onJump(target);
    }

    function keydown(event: KeyboardEvent) {
        const index = axis.indexOf(first);
        let target: string | null = null;
        if (event.key === 'ArrowUp') target = axis.keyAt(Math.max(0, index - 1));
        else if (event.key === 'ArrowDown') target = axis.keyAt(Math.min(axis.count - 1, index + 1));
        else if (event.key === 'PageUp') target = nearestKey(axis, shiftMonthKey(first, 12));
        else if (event.key === 'PageDown') target = nearestKey(axis, shiftMonthKey(first, -12));
        else if (event.key === 'Home') {
            event.preventDefault();
            onLatest();
            return;
        } else if (event.key === 'End') target = axis.keyAt(axis.count - 1);
        if (!target) return;
        event.preventDefault();
        onJump(target);
    }
</script>

{#if newest}
    <div
        bind:this={root}
        bind:clientWidth={width}
        bind:clientHeight={height}
        class="gallery-spine"
        class:shown
        class:wide
        role="slider"
        tabindex="0"
        aria-label="Months"
        aria-orientation="vertical"
        aria-valuemin={0}
        aria-valuemax={Math.max(0, axis.count - 1)}
        aria-valuenow={axis.indexOf(first)}
        aria-valuetext={first ? label(first) : undefined}
        onpointermove={(event) => { const month = point(event); if (dragging) jump(month); }}
        onpointerdown={(event) => { dragging = true; jumped = ''; root?.setPointerCapture(event.pointerId); jump(point(event)); }}
        onpointerup={() => { dragging = false; }}
        onpointercancel={() => { dragging = false; hover = null; }}
        onpointerleave={() => { if (!dragging) hover = null; }}
        onkeydown={keydown}
    >
        <canvas bind:this={canvas} aria-hidden="true"></canvas>
        {#if hover}
            <span class="gallery-spine-tip" style:top={`${monthY(hover)}px`} aria-hidden="true">
                {label(hover)}<small>{photosByMonth.has(hover) ? `${formatNumber(photosByMonth.get(hover) ?? 0)} ${photosByMonth.get(hover) === 1 ? 'photo' : 'photos'}` : 'No photos'}</small>
            </span>
        {/if}
    </div>
{/if}

<style>
    .gallery-spine {
        position: absolute;
        top: 0;
        right: 0;
        bottom: 0;
        z-index: 3;
        width: 22px;
        cursor: ns-resize;
        touch-action: none;
        opacity: 0;
        pointer-events: none;
        transition: opacity 300ms ease;
    }
    .gallery-spine.shown, .gallery-spine:focus-visible { opacity: 1; pointer-events: auto; }
    /* CSS sets the width; a wide spine is always shown. */
    .gallery-spine.wide { opacity: 1; pointer-events: auto; }
    .gallery-spine:focus-visible { outline: 2px solid var(--stor-focus); outline-offset: -4px; border-radius: 12px; }
    canvas { display: block; width: 100%; height: 100%; }
    .gallery-spine-tip {
        position: absolute;
        right: calc(100% + 6px);
        z-index: 4;
        display: inline-flex;
        align-items: baseline;
        gap: 6px;
        padding: 7px 11px;
        border-radius: 999px;
        background: var(--stor-ink);
        box-shadow: var(--stor-shadow-md);
        color: var(--stor-surface);
        font-size: 12px;
        font-weight: 600;
        line-height: 1;
        white-space: nowrap;
        pointer-events: none;
        transform: translateY(-50%);
    }
    .gallery-spine-tip small { font-size: 11.5px; font-weight: 500; opacity: 0.72; }
    @media (min-width: 640px) {
        .gallery-spine { width: 72px; }
    }
    @media (prefers-reduced-motion: reduce) {
        .gallery-spine { transition: none; }
    }
</style>
