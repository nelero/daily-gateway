import Router from 'koa-router';
import validator, {
  object,
  string,
  boolean,
} from 'koa-context-validator';
import { ForbiddenError, ValidationError } from '../errors';
import provider from '../models/provider';
import userModel from '../models/user';
import role from '../models/role';
import visit from '../models/visit';
import { getTrackingId, setTrackingId } from '../tracking';
import config from '../config';
import { setAuthCookie, addSubdomainOpts } from '../cookies';
import { publishEvent, userUpdatedTopic } from '../pubsub';
import upload from '../upload';
import { uploadAvatar } from '../cloudinary';

const updateUser = async (userId, user, newProfile) => {
  await userModel.update(userId, newProfile);
  await publishEvent(userUpdatedTopic, { user, newProfile });
};

const router = Router({
  prefix: '/users',
});

router.get(
  '/me',
  async (ctx) => {
    let visitId;
    const trackingId = getTrackingId(ctx);
    if (ctx.state.user) {
      const { userId } = ctx.state.user;
      visitId = userId;

      const [user, userProvider, roles] = await Promise.all([
        userModel.getById(userId),
        provider.getByUserId(userId),
        role.getByUserId(userId),
      ]);
      if (!user) {
        setTrackingId(ctx, null);
        throw new ForbiddenError();
      }

      if (!ctx.userAgent.isBot && !ctx.state.service) {
        // Refresh the auth cookie
        await setAuthCookie(ctx, user, roles);
      }

      ctx.status = 200;
      ctx.body = { ...user, providers: [userProvider.provider], roles };
    } else if (trackingId && trackingId.length) {
      visitId = trackingId;
      ctx.status = 200;
      ctx.body = { id: trackingId };
    } else {
      throw new ForbiddenError();
    }

    const app = ctx.request.get('app');
    if (app === 'extension') {
      const referral = ctx.cookies.get(config.cookies.referral.key, config.cookies.referral.opts);
      visit.upsert(visitId, app, new Date(), new Date(), referral)
        .catch((err) => ctx.log.error({ err }, `failed to update visit for ${visitId}`));
    }
  },
);

router.put(
  '/me',
  validator({
    body: object().keys({
      name: string().required(),
      email: string().email().required(),
      company: string().allow(null),
      title: string().allow(null),
      acceptedMarketing: boolean(),
    }),
  }, { stripUnknown: true }),
  async (ctx) => {
    if (ctx.state.user) {
      const { userId } = ctx.state.user;
      const user = await userModel.getById(userId);
      if (!user) {
        throw new ForbiddenError();
      }
      const { body } = ctx.request;
      const newProfile = {
        ...user,
        acceptedMarketing: true,
        ...body,
        infoConfirmed: true,
      };
      const dup = await userModel.checkDuplicateEmail(userId, newProfile.email);
      if (dup) {
        throw new ValidationError('email', 'email already exists');
      }
      ctx.log.info(`updating profile for ${userId}`);
      await updateUser(userId, user, newProfile);
      ctx.body = newProfile;
      ctx.status = 200;
    } else {
      throw new ForbiddenError();
    }
  },
);

router.get(
  '/me/info',
  async (ctx) => {
    if (ctx.state.user) {
      const { userId } = ctx.state.user;
      const user = await userModel.getById(userId);
      if (!user) {
        throw new ForbiddenError();
      }
      ctx.body = { name: user.name, email: user.email };
      ctx.status = 200;
    } else {
      throw new ForbiddenError();
    }
  },
);

router.get(
  '/me/roles',
  async (ctx) => {
    if (ctx.state.user) {
      const { userId } = ctx.state.user;
      ctx.body = await role.getByUserId(userId);
      ctx.status = 200;
    } else {
      throw new ForbiddenError();
    }
  },
);

router.post(
  '/logout',
  async (ctx) => {
    setTrackingId(ctx, undefined);
    ctx.cookies.set(
      config.cookies.auth.key,
      undefined, addSubdomainOpts(ctx, config.cookies.auth.opts),
    );
    ctx.cookies.set(
      config.cookies.referral.key,
      undefined, addSubdomainOpts(ctx, config.cookies.referral.opts),
    );
    ctx.status = 204;
  },
);

router.post(
  '/me/image',
  async (ctx) => {
    if (ctx.state.user) {
      const { userId } = ctx.state.user;
      const { file } = await upload(ctx.req, { limits: { files: 1, fileSize: 5 * 1024 * 1024 } });
      ctx.log.info(`updating image for ${userId}`);
      const avatarUrl = await uploadAvatar(userId, file);
      const user = await userModel.getById(userId);
      const newProfile = {
        ...user,
        image: avatarUrl,
      };
      await updateUser(userId, user, newProfile);
      ctx.body = newProfile;
      ctx.status = 200;
    } else {
      throw new ForbiddenError();
    }
  },
);

export default router;
