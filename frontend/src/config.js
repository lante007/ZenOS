const env = import.meta.env;

export const tenantConfig = {
  tenant: env.VITE_TENANT || env.REACT_APP_TENANT || 'zenex',
  orgName: env.VITE_ORG_NAME || env.REACT_APP_ORG_NAME || 'Zenex Foundation',
  primary: env.VITE_PRIMARY_COLOR || env.REACT_APP_PRIMARY_COLOR || '#EF7218',
  secondary: env.VITE_SECONDARY_COLOR || env.REACT_APP_SECONDARY_COLOR || '#311F47',
  logoUrl: env.VITE_LOGO_URL || env.REACT_APP_LOGO_URL || '/zenex-logo.png',
  apiUrl: env.VITE_API_URL || env.REACT_APP_API_URL || 'http://localhost:3001',
  cognitoDomain: env.VITE_COGNITO_DOMAIN || env.REACT_APP_COGNITO_DOMAIN || '',
  cognitoClientId: env.VITE_COGNITO_CLIENT_ID || env.REACT_APP_COGNITO_CLIENT_ID || '',
  cognitoRegion: env.VITE_COGNITO_REGION || env.REACT_APP_COGNITO_REGION || 'us-east-1',
  cognitoRedirectUri: env.VITE_COGNITO_REDIRECT_URI || env.REACT_APP_COGNITO_REDIRECT_URI || `${window.location.origin}/dashboard`,
};
