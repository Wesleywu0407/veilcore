const cache = new Map();
let loaderPromise = null;

async function loader() {
  if (!loaderPromise) {
    loaderPromise = import('three/addons/loaders/GLTFLoader.js')
      .then(({ GLTFLoader }) => new GLTFLoader());
  }
  return loaderPromise;
}

/**
 * Load one GLB once per page and share its immutable geometry, textures and
 * clips between callers. A failed request is removed from the cache so a retry
 * after a transient network error still has a chance to succeed.
 */
export function loadGLB(url) {
  if (!cache.has(url)) {
    const task = loader()
      .then(instance => instance.loadAsync(url))
      .catch(error => {
        cache.delete(url);
        throw error;
      });
    cache.set(url, task);
  }
  return cache.get(url);
}
