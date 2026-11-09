import { X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { ChatImage } from '../chat.ts';
import { copy, type Locale } from '../copy.ts';

interface ImagePreviewProps {
  image: ChatImage;
  locale: Locale;
  onClose: () => void;
}

/** Native modal dialog supplies focus trapping, Escape, and focus restoration. */
export function ImagePreview({ image, locale, onClose }: ImagePreviewProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const text = copy[locale];
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return <dialog ref={dialog} className="image-dialog" aria-label={text.imagePreview} onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => {
    if (event.target === event.currentTarget) {
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
    }
  }}>
    <div className="image-dialog-header">
      <span>{image.name}</span>
      <button type="button" aria-label={text.closeImage} title={text.closeImage} onClick={onClose}><X size={20} strokeWidth={1.5} /></button>
    </div>
    <img className="image-dialog-content" src={image.dataUrl} alt={image.name} />
  </dialog>;
}
