const Jimp = require('jimp');

async function resize() {
  const imagePath = 'src/logo.png';
  const sidebarPath = 'src-tauri/icons/nsis-sidebar.bmp';
  const headerPath = 'src-tauri/icons/nsis-header.bmp';

  const img1 = await Jimp.read(imagePath);
  img1.contain(164, 314)
      .background(0xFFFFFFFF) // White background
      .write(sidebarPath);

  const img2 = await Jimp.read(imagePath);
  img2.contain(150, 57)
      .background(0xFFFFFFFF) // White background
      .write(headerPath);

  console.log('Images resized and saved.');
}

resize().catch(console.error);
