    const params = new URLSearchParams(window.location.search);
    if (params.has('error')) {
      const errBox = document.getElementById('error-box');
      errBox.className = 'error-message';
      const reason = params.get('error');
      if (reason === 'not_allowed') {
        errBox.innerText = 'Authentication succeeded, but your GitHub user is not in the allowed access list.';
      } else if (reason === 'no_config') {
        errBox.innerText = 'GitHub OAuth environment variables are not configured on the server.';
      } else {
        errBox.innerText = 'GitHub OAuth validation failed. Please try again.';
      }
    }
