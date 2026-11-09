import { useEffect, useRef, useState } from 'react';
import type { ChatImage } from './chat.ts';
import { ImagePreparationError, prepareImage, validateImageSelection } from './images.ts';

/** Each selected file retains its own delivery state until sent or removed. */
export type DraftImage = {
  id: string;
  name: string;
} & ({ status: 'processing' } | { status: 'ready'; image: ChatImage } | { status: 'error'; code: string });

/** Local image preparation cannot repopulate a reset or unmounted conversation. */
export function useImages() {
  const [images, setImages] = useState<DraftImage[]>([]);
  const [errorCode, setErrorCode] = useState<string | undefined>();
  const current = useRef<DraftImage[]>([]);
  const generation = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current++; };
  }, []);

  function update(next: DraftImage[]) {
    current.current = next;
    setImages(next);
  }

  function addImages(files: File[]) {
    if (!files.length) return;
    try { validateImageSelection(files, current.current.length); }
    catch (error) {
      setErrorCode(error instanceof ImagePreparationError ? error.code : 'INVALID_IMAGE');
      return;
    }
    setErrorCode(undefined);
    const token = generation.current;
    const entries: DraftImage[] = files.map((file) => ({ id: crypto.randomUUID(), name: file.name, status: 'processing' }));
    update([...current.current, ...entries]);
    // Decode sequentially to avoid holding four full-size camera images in memory.
    void (async () => {
      for (let index = 0; index < files.length; index++) {
        const entry = entries[index];
        const file = files[index];
        if (!entry || !file || !mounted.current || token !== generation.current) break;
        if (!current.current.some((image) => image.id === entry.id)) continue;
        let next: DraftImage;
        try { next = { ...entry, status: 'ready', image: await prepareImage(file) }; }
        catch (error) { next = { ...entry, status: 'error', code: error instanceof ImagePreparationError ? error.code : 'INVALID_IMAGE' }; }
        if (mounted.current && token === generation.current) update(current.current.map((image) => image.id === entry.id ? next : image));
      }
    })();
  }

  function removeImage(id: string) {
    update(current.current.filter((image) => image.id !== id));
    setErrorCode(undefined);
  }

  function clearImages() {
    generation.current++;
    update([]);
    setErrorCode(undefined);
  }

  function readyImages(): ChatImage[] | undefined {
    if (current.current.some((image) => image.status !== 'ready')) return undefined;
    return current.current.flatMap((image) => image.status === 'ready' ? [image.image] : []);
  }

  return { images, errorCode, setErrorCode, addImages, removeImage, clearImages, readyImages };
}
