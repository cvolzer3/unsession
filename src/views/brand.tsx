/** Product-owned Unsession brand primitives. Event-owned public surfaces keep
 * using their event logo or initials instead of inheriting this lockup. */
import type { FC } from 'hono/jsx';

export const PRODUCT_LOGO_SRC = '/brand/unsession-logo.svg';
export const PRODUCT_MARK_SRC = '/brand/unsession-mark.svg';

export const ProductLogo: FC<{
  height?: number;
  alt?: string;
  class?: string;
  style?: string;
}> = ({ height = 22, alt = 'Unsession', class: className, style = '' }) => (
  <img
    src={PRODUCT_LOGO_SRC}
    alt={alt}
    class={className}
    width={Math.round(height * 6.5)}
    height={height}
    style={`display:block;width:auto;height:${height}px;${style}`}
  />
);

export const ProductMark: FC<{
  size?: number;
  alt?: string;
  class?: string;
  style?: string;
}> = ({ size = 24, alt = '', class: className, style = '' }) => (
  <img
    src={PRODUCT_MARK_SRC}
    alt={alt}
    class={className}
    width={size}
    height={size}
    aria-hidden={alt ? undefined : 'true'}
    style={`display:block;width:${size}px;height:${size}px;${style}`}
  />
);
