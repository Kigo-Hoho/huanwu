import type { ChangeEvent } from 'react';

import type { AcceptanceImageInputProps } from './acceptance-image-input';

export function AcceptanceImageInput({
  disabled,
  onSelect,
}: AcceptanceImageInputProps) {
  if (__IDENTITY_PROVIDER__ !== 'acceptance') return null;

  function selectFiles(event: ChangeEvent<HTMLInputElement>): void {
    const files = Array.from(event.currentTarget.files ?? []);
    onSelect(files.map((file) => URL.createObjectURL(file)));
  }

  return (
    <label>
      <span>物品图片</span>
      <input
        aria-label="物品图片"
        type="file"
        accept="image/jpeg,image/png,image/webp"
        multiple
        disabled={disabled}
        onChange={selectFiles}
      />
    </label>
  );
}
