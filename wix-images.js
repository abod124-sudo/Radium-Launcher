const Jimp = require('jimp');

async function resize() {
  const imagePath = 'src/logo.png';
  const dialogPath = 'src-tauri/icons/wix-dialog.bmp';
  const bannerPath = 'src-tauri/icons/wix-banner.bmp';

  const img1 = await Jimp.read(imagePath);
  img1.contain(493, 312)
      .background(0xFFFFFFFF) // White background
      .write(dialogPath);

  const img2 = await Jimp.read(imagePath);
  img2.contain(493, 58)
      .background(0xFFFFFFFF) // White background
      .write(bannerPath);

  console.log('WiX Images resized and saved.');
}

resize().catch(console.error);
