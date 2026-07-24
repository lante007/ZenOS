'use strict';

exports.handler = async event => {
  const email = event.request.userAttributes.email;
  const allowed = process.env.ALLOWED_DOMAINS.split(',');
  const domain = email.split('@')[1];
  if (!allowed.includes(domain)) {
    throw new Error('Email domain not authorised for this organisation.');
  }
  return event;
};
