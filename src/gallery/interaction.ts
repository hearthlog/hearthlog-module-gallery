export function gallerySwipeDirection(startX: number, startY: number, endX: number, endY: number): -1 | 0 | 1 {
    const horizontal = endX - startX;
    const vertical = endY - startY;
    if (Math.abs(horizontal) < 60 || Math.abs(horizontal) < Math.abs(vertical) * 1.5) return 0;
    return horizontal < 0 ? 1 : -1;
}
