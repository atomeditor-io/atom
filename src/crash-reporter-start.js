module.exports = function(params) {
  const { crashReporter } = require('electron');
  const os = require('os');
  const platformRelease = os.release();
  const arch = os.arch();
  const { uploadToServer, releaseChannel } = params;

  const parsedUploadToServer = uploadToServer !== null ? uploadToServer : false;

  crashReporter.start({
    productName: 'Atom',
    companyName: 'atomeditor-io',
    submitURL: 'https://github.com/atomeditor-io/atom/issues',
    parsedUploadToServer,
    extra: { platformRelease, arch, releaseChannel }
  });
};
