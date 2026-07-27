'use strict';

function orgTypeContext(tenant) {
  return tenant?.organisation_type === 'FUNDER'
    ? 'This organisation is a philanthropy and funder. It commissions and funds programmes implemented by others. Use attribution language: "Zenex-funded evidence shows" or "Zenex-commissioned evaluation found". Never say "Zenex delivered" or "Zenex achieved".'
    : 'This organisation is an implementing NGO. It directly delivers programmes. Attribution is direct.';
}

module.exports = { orgTypeContext };
