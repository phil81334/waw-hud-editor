# Attribution

Created by **phil81334** for the World at War modding community.

- IWI decoding uses the released WaW Image Viewer reader. Wavelet decoding/codewords were adapted into Rust from [OpenAssetTools](https://github.com/Laupetin/OpenAssetTools), by Laupetin and its contributors, under GPL-3.0. The source reference was revision `30d2d498bd8e3f2401037b24f3db6f96d39554c4`. This app stores its lookup tables on the heap; decoding was checked against the retained independent image corpus.
- Local PNG/JPEG/WebP/BMP/TGA image reading and thumbnail generation use the [Rust image crate](https://github.com/image-rs/image) under MIT/Apache-2.0, with its dependencies recorded in Cargo.lock.
- Built with Tauri, Vite, the Rust zip library and their dependencies. Versions are recorded in the lockfiles.

No game fonts, materials, images or original executables are bundled. Previews read the user's installed assets; those assets remain the property of their respective owners.

This is an independent community app, not an official Treyarch, Activision or UGX product.
