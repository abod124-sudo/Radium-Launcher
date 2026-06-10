const Jimp = require('jimp');

async function resize() {
  const imagePath = 'src/logo.png';
  
  const logo = await Jimp.read(imagePath);
  
  // WiX Dialog Image: 493x312. Logo goes on the left column (164x312)
  const dialogImg = new Jimp(493, 312, 0xFFFFFFFF);
  const dialogLogo = logo.clone().contain(164, 312);
  dialogImg.composite(dialogLogo, 0, 0);
  dialogImg.write('src-tauri/icons/wix-dialog.bmp');

  // WiX Banner Image: 493x58. Logo goes on the right edge
  const bannerImg = new Jimp(493, 58, 0xFFFFFFFF);
  const bannerLogo = logo.clone().contain(58, 58);
  bannerImg.composite(bannerLogo, 493 - 58 - 15, 0); // 15px padding from right
  bannerImg.write('src-tauri/icons/wix-banner.bmp');
  
  console.log("WiX images aligned and saved.");
}

resize().catch(console.error);
