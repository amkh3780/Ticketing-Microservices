import request from "supertest"; //supertest : Allow us to fake a req to Express App
import { app } from "../../app";

it("clears the cookies after signing out", async () => {
  await request(app)
    .post("/api/users/signup")
    .send({
      email: "test@test.com",
      password: "password",
    })
    .expect(201);

  const response = await request(app)
    .post("/api/users/signout")
    .send({})
    .expect(200);

  //   console.log(response.get("Set-Cookie"));

  const cookie = response.get("Set-Cookie")[0];
  expect(cookie).toContain("session=;");
  expect(cookie).toContain("expires=Thu, 01 Jan 1970 00:00:00 GMT");
  expect(cookie.toLowerCase()).toContain("httponly");
});
