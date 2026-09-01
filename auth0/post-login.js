/**
 * Auth0 Action: Classroom roles
 * Trigger: Login / Post Login
 *
 * Deploy this Action and add it to the Login flow. Assign the Auth0 role
 * named "Admin" to school administrators. The Worker reads this namespaced
 * claim and always enforces the permission again on the API.
 */
exports.onExecutePostLogin = async (event, api) => {
  const claim = "https://classroom.sorasukt.com/roles";
  const roles = event.authorization?.roles || [];
  api.idToken.setCustomClaim(claim, roles);
  api.accessToken.setCustomClaim(claim, roles);
};
